import { realpath, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
export interface Proposal { id: string; path: string; before: string; after: string; }
/** No agent-facing tool can apply a proposal. Only the editor's explicit review can. */
export class ProposalStore {
  private items = new Map<string, Proposal>();
  constructor(readonly root: string) {}
  async safePath(path: string): Promise<string> {
    const root = await realpath(this.root);
    const target = await realpath(resolve(root, path));
    const rel = relative(root, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('File must be inside workspace');
    return target;
  }
  async read(path: string) { return readFile(await this.safePath(path), 'utf8'); }
  async propose(path: string, content: string): Promise<Proposal> {
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('Proposal exceeds 1 MiB');
    const p = { id: randomUUID(), path: await this.safePath(path), before: await this.read(path), after: content };
    this.items.set(p.id, p); return p;
  }
  list() { return [...this.items.values()]; }
  get(id: string) { const p = this.items.get(id); if (!p) throw new Error('Unknown proposal'); return p; }
  reject(id: string) { this.items.delete(id); }
  async apply(id: string) {
    const p = this.get(id);
    if (await this.read(p.path) !== p.before) throw new Error('File changed since proposal; regenerate it');
    await writeFile(p.path, p.after); this.items.delete(id);
  }
}
