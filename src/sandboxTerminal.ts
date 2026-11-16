import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ProposalStore } from "./proposals.js";
import type { TerminalApproval, TerminalRequest, TerminalResult } from "./terminal.js";

const OUTPUT_LIMIT = 16 * 1024;
const active = new WeakSet<ProposalStore>();
// --unshare-all does not satisfy bubblewrap's explicit --disable-userns check.
export const SANDBOX_NAMESPACE_ARGS = Object.freeze(["--unshare-all", "--unshare-user", "--disable-userns"]);
function decodeBounded(buffer: Buffer) {
  let text=buffer.toString("utf8");
  while(Buffer.byteLength(text)>buffer.length) text=text.slice(0,-1);
  if(text && /[\uD800-\uDBFF]/.test(text[text.length-1])) text=text.slice(0,-1);
  return text;
}
export function isSandboxRecipe(request: TerminalRequest): boolean {
  if (request.command !== "python3" || request.args[0] !== "-m" || !["pytest", "unittest"].includes(request.args[1])) return false;
  if (request.args.length > 16) return false;
  return request.args.slice(2).every(arg =>
    ["-q", "-v", "--disable-warnings", "--maxfail=1", "discover", "-s", "-p"].includes(arg) ||
    (/^[a-zA-Z0-9_][a-zA-Z0-9_./*:-]{0,200}$/.test(arg) && !arg.split(/[/:]/).includes("..")));
}

/** Bounded process supervisor. Production calls only the fixed sandbox binary. */
export async function supervise(command: string, args: string[], signal?: AbortSignal, timeoutMs = 30000): Promise<TerminalResult> {
  if (signal?.aborted) return {status:"cancelled",stdout:"",stderr:"Cancelled before execution.",truncated:false};
  return new Promise(resolve => {
    const child = spawn(command, args, { shell:false, detached:process.platform!=="win32", stdio:["ignore","pipe","pipe"], env:{PATH:"/usr/bin:/bin",LANG:"C.UTF-8"} });
    let stdout=Buffer.alloc(0), stderr=Buffer.alloc(0), bytes=0, truncated=false;
    let stopped: "cancelled"|"timed_out"|undefined;
    const kill = () => { try { if (process.platform!=="win32" && child.pid) process.kill(-child.pid,"SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ } };
    const cancel = () => { stopped="cancelled"; kill(); };
    signal?.addEventListener("abort",cancel,{once:true});
    if(signal?.aborted) cancel();
    const timer=setTimeout(()=>{stopped="timed_out";kill();},timeoutMs);
    const collect=(part:Buffer,stream:"stdout"|"stderr")=>{
      const available=Math.max(0,OUTPUT_LIMIT-bytes), kept=part.subarray(0,available);bytes+=kept.length;
      if(stream==="stdout") stdout=Buffer.concat([stdout,kept]);else stderr=Buffer.concat([stderr,kept]);
      if(part.length>available){truncated=true;kill();}
    };
    child.stdout.on("data",part=>collect(part,"stdout"));child.stderr.on("data",part=>collect(part,"stderr"));
    let spawnError="";
    child.on("error",error=>{spawnError=error.message;});
    child.on("close",code=>{
      clearTimeout(timer);signal?.removeEventListener("abort",cancel);
      // Kill descendants even if the recipe's parent exits early.
      kill();
      resolve({status:stopped??(code===0&&!truncated?"completed":"failed"),exitCode:code,
        stdout:decodeBounded(stdout),stderr:decodeBounded(stderr)||spawnError,truncated});
    });
  });
}

export async function runSandboxTerminal(store: ProposalStore, input: TerminalRequest, approve?: TerminalApproval, signal?: AbortSignal): Promise<TerminalResult> {
  const request=Object.freeze({command:input.command,args:Object.freeze([...input.args]),execution:"sandbox" as const});
  const unsupported=(stderr:string):TerminalResult=>({status:"unsupported",stdout:"",stderr,truncated:false});
  if(!isSandboxRecipe(request)) return unsupported("Only python3 -m pytest/unittest with bounded test paths/options is executable. No shell or arbitrary program execution.");
  if(process.platform!=="linux") return unsupported("Sandbox test execution requires Linux bubblewrap; no host fallback is permitted.");
  if(!process.getuid || process.getuid()===0) return unsupported("Sandbox test execution requires a non-root user so the no-fork process limit is enforced. No host fallback is permitted.");
  for(const path of ["/usr/bin/bwrap","/usr/bin/prlimit","/usr/bin/python3"])
    try{await access(path,constants.X_OK);}catch{return unsupported(`Required sandbox runtime is unavailable: ${path}. No host command was executed.`);}
  if(active.has(store)) return unsupported("One sandbox test may run per workspace at a time.");
  active.add(store);
  let snapshot:string|undefined;
  try {
    if(signal?.aborted) return {status:"cancelled",stdout:"",stderr:"Cancelled before approval.",truncated:false};
    if(!approve || !(await approve(request))) return {status:"denied",stdout:"",stderr:"Explicit approval was not granted. No repository code executed.",truncated:false};
    if(signal?.aborted) return {status:"cancelled",stdout:"",stderr:"Cancelled before execution.",truncated:false};
    snapshot=await mkdtemp(join(tmpdir(),"fakefoundy-test-"));
    await prepareSnapshot(store,snapshot,signal);
    const args=[...SANDBOX_NAMESPACE_ARGS,"--die-with-parent","--new-session","--uid",String(process.getuid!()),"--gid",String(process.getgid!()),"--cap-drop","ALL","--clearenv"];
    for(const path of ["/usr/bin","/usr/lib","/usr/lib64","/bin","/lib","/lib64"]) {
      try{await access(path);args.push("--ro-bind",path,path);}catch{/* optional runtime directory */}
    }
    args.push("--proc","/proc","--dev","/dev","--size","67108864","--tmpfs","/tmp","--dir","/home","--dir","/home/test",
      "--ro-bind",snapshot,"/workspace","--chdir","/workspace","--setenv","HOME","/home/test",
      "--setenv","PATH","/usr/bin:/bin","--setenv","LANG","C.UTF-8","--setenv","PYTHONPATH","/workspace/src:/workspace",
      "--setenv","PYTHONDONTWRITEBYTECODE","1","--setenv","PYTEST_DISABLE_PLUGIN_AUTOLOAD","1","--remount-ro","/dev","--remount-ro","/proc","--remount-ro","/",
      "--","/usr/bin/prlimit","--as=268435456","--cpu=30","--fsize=8388608","--nproc=1","--nofile=128","--",
      "/usr/bin/python3",...request.args);
    const result=await supervise("/usr/bin/bwrap",args,signal);
    if(result.status==="failed") result.stderr += "\nSandbox/test failed. No host fallback was attempted. Only system Python dependencies are available; network and dependency installation are disabled.";
    return result;
  } finally { if(snapshot) await rm(snapshot,{recursive:true,force:true});active.delete(store); }
}

/** Copies text and staged patches only; never launches repository code. */
export async function prepareSnapshot(store: ProposalStore, snapshot: string, signal?: AbortSignal): Promise<void> {
    const listing=await store.discover("",500);
    if(listing.truncated) throw new Error("Workspace exceeds the 500-file snapshot bound. Narrow the workspace; no incomplete test snapshot is executed.");
    const canonicalRoot=await realpath(store.root);
    const canonicalSnapshot=await realpath(snapshot);
    const proposals=new Map<string,string>();
    for(const proposal of store.list().map(p=>({...p}))) {
      const canonicalPath=await store.safePath(proposal.path);
      if((await store.read(canonicalPath)) !== proposal.before)
        throw new Error("File changed since proposal; regenerate before testing staged edits");
      const path=relative(canonicalRoot,canonicalPath).replaceAll("\\","/");
      if(!path || isAbsolute(path) || path.split("/").includes(".."))
        throw new Error("Proposal path escapes canonical workspace");
      proposals.set(path,proposal.after);
    }
    let total=0;
    for(const path of new Set([...listing.files,...proposals.keys()])) {
      if(signal?.aborted) throw new Error("Cancelled while preparing snapshot.");
      await store.safePath(path);
      const content=proposals.get(path)??await store.read(path);
      total+=Buffer.byteLength(content);
      if(total>20*1024*1024) throw new Error("Workspace exceeds the 20 MiB text snapshot bound. Nothing executed.");
      if(!path || isAbsolute(path) || path.split(/[\\/]/).includes(".."))
        throw new Error("Snapshot path escapes workspace");
      const target=resolve(canonicalSnapshot,path);
      const snapshotRelative=relative(canonicalSnapshot,target);
      if(!snapshotRelative || isAbsolute(snapshotRelative) || snapshotRelative.split(/[\\/]/).includes(".."))
        throw new Error("Snapshot destination escapes temporary directory");
      await mkdir(dirname(target),{recursive:true});
      const parentRelative=relative(canonicalSnapshot,await realpath(dirname(target)));
      if(isAbsolute(parentRelative) || parentRelative.split(/[\\/]/).includes(".."))
        throw new Error("Snapshot directory escapes temporary directory");
      await writeFile(target,content,{flag:"wx"});
    }
}
