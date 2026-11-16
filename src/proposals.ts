import { realpath, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { diffHunks, applyHunks, Hunk } from "./hunks.js";
export interface Proposal {
  hunks: Hunk[];
  id: string;
  path: string;
  before: string;
  after: string;
}
/** No agent-facing tool can apply a proposal. Only the editor's explicit review can. */
export class ProposalStore {
  private items = new Map<string, Proposal>();
  private generation = 0;
  private active = true;
  beginRun() { this.generation++; this.active = true; }
  endRun() { this.generation++; this.active = false; }
  invalidatePending() { this.endRun(); }
  constructor(readonly root: string) {}
  async safePath(path: string): Promise<string> {
    const sensitive = (p: string) =>
      p
        .split(/[\\/]/)
        .some(
          (part) =>
            [
              ".git",
              ".ssh",
              ".aws",
              ".gnupg",
              ".npmrc",
              ".netrc",
              "id_rsa",
              "id_ed25519",
            ].includes(part) ||
            part === ".env" ||
            part.startsWith(".env.") ||
            /\.(pem|key|p12|pfx)$/i.test(part),
        );
    if (sensitive(path))
      throw new Error("Sensitive file paths are not exposed to the agent");
    const root = await realpath(this.root);
    const target = await realpath(resolve(root, path));
    const rel = relative(root, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw new Error("File must be inside workspace");
    if (sensitive(rel))
      throw new Error("Sensitive file paths are not exposed to the agent");
    const info = await stat(target);
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new Error("Only regular files up to 1 MiB are supported");
    return target;
  }
  async read(path: string) {
    const content = await readFile(await this.safePath(path), "utf8");
    if (content.includes("\0")) throw new Error("Binary files are not supported");
    return content;
  }
  async propose(path: string, content: string): Promise<Proposal> {
    const generation = this.generation;
    if (!this.active) throw new Error("No active agent run");
    if (Buffer.byteLength(content) > 1024 * 1024)
      throw new Error("Proposal exceeds 1 MiB");
    const before = await this.read(path);
    const p = {
      id: randomUUID(),
      path: await this.safePath(path),
      before,
      hunks: diffHunks(before, content),
      after: content,
    };
    if (!this.active || generation !== this.generation) throw new Error("Agent run ended; proposal discarded");
    this.items.set(p.id, p);
    return p;
  }
  /** Bounded discovery: never follows symlink directories or exposes hidden/generated trees. */
  async discover(query = "", limit = 100) {
    const files: string[] = [];
    // Git supplies ignore semantics without executing project code or a shell.
    let allowed: Set<string> | undefined;
    try {
      const {stdout} = await promisify(execFile)("git", ["-C", this.root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {timeout:2000,maxBuffer:2*1024*1024});
      allowed = new Set(stdout.split("\0").filter(Boolean));
    } catch { /* Non-Git folders retain the conservative built-in exclusions. */ }

    const pending = [""];
    let scanned = 0;
    const cap = Math.max(1, Math.min(limit, 500));
    const omitted = new Set(["node_modules", "dist", "build", "coverage", "vendor", "__pycache__"]);
    while (pending.length && files.length < cap && scanned < 5000) {
      const dir = pending.pop()!;
      const entries = await readdir(resolve(this.root, dir), {withFileTypes:true});
      entries.sort((a,b)=>a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (++scanned > 5000 || files.length >= cap) break;
        if (entry.name.startsWith(".") || omitted.has(entry.name) || entry.isSymbolicLink()) continue;
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && (!allowed || allowed.has(path)) && path.toLowerCase().includes(query.toLowerCase())) {
          try { await this.safePath(path); files.push(path); } catch { /* protected file */ }
        }
      }
    }
    return {files, truncated: pending.length > 0 || files.length >= cap || scanned >= 5000};
  }
  async search(query: string, limit = 50) {
    if (!query) throw new Error("Search text must not be empty");
    const candidates = await this.discover("", 500);
    const matches: {path:string; line:number; text:string}[] = [];
    const cap = Math.max(1, Math.min(limit, 100));
    let bytes = 0;
    for (const path of candidates.files) {
      let content: string;
      try {content = await this.read(path);} catch {continue;}
      bytes += Buffer.byteLength(content);
      if (bytes > 5 * 1024 * 1024) return {matches,truncated:true};
      for (const [index,line] of content.split("\n").entries()) {
        if (line.toLowerCase().includes(query.toLowerCase())) matches.push({path,line:index+1,text:line.slice(0,500)});
        if (matches.length >= cap) return {matches,truncated:true};
      }
    }
    return {matches,truncated:candidates.truncated};
  }
  preview(id: string, accepted: readonly number[]) {
    const p = this.get(id);
    return applyHunks(p.before, p.hunks, accepted);
  }
  list() {
    return [...this.items.values()];
  }
  get(id: string) {
    const p = this.items.get(id);
    if (!p) throw new Error("Unknown proposal");
    return p;
  }
  reject(id: string) {
    this.items.delete(id);
  }
  async apply(id: string) {
    const p = this.get(id);
    if ((await this.read(p.path)) !== p.before)
      throw new Error("File changed since proposal; regenerate it");
    await writeFile(p.path, p.after);
    this.items.delete(id);
  }
}
