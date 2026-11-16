import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm,mkdir,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {supervise,isSandboxRecipe,runSandboxTerminal,prepareSnapshot,SANDBOX_NAMESPACE_ARGS} from "../sandboxTerminal.js";
import {ProposalStore} from "../proposals.js";

test("sandbox admits only bounded Python test recipes, not shell/code injection",()=>{
  assert.equal(isSandboxRecipe({command:"python3",args:["-m","pytest","tests/test_app.py","-q"]}),true);
  assert.equal(isSandboxRecipe({command:"python3",args:["-m","unittest","discover","-s","tests"]}),true);
  for(const args of [["-c","print('bad')"],["-m","pytest","../outside.py"],["-m","pytest","/etc/passwd"],["-m","pytest","-p","evil;rm"],["-m","pip","install","thing"],["-m","pytest","--override-ini=anything"]])
    assert.equal(isSandboxRecipe({command:"python3",args}),false);
});

test("process supervisor cancels promptly and never starts already-aborted work",async()=>{
  const c=new AbortController();
  const pending=supervise(process.execPath,["-e","setInterval(()=>{},1000)"],c.signal,5000);
  setTimeout(()=>c.abort(),50);
  const r=await pending;assert.equal(r.status,"cancelled");
  const stopped=await supervise("/does/not/exist",[],c.signal);
  assert.equal(stopped.status,"cancelled");
});

test("process supervisor bounds wall time and combined output",async()=>{
  const timed=await supervise(process.execPath,["-e","setInterval(()=>{},1000)"],undefined,50);
  assert.equal(timed.status,"timed_out");
  const noisy=await supervise(process.execPath,["-e","process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)"],undefined,3000);
  assert.equal(noisy.truncated,true);assert.equal(noisy.status,"failed");
  assert.ok(Buffer.byteLength(noisy.stdout)+Buffer.byteLength(noisy.stderr)<=16384);
});

test("sandbox explicitly creates a user namespace before disabling nested user namespaces",()=>{
  assert.deepEqual([...SANDBOX_NAMESPACE_ARGS],["--unshare-all","--unshare-user","--disable-userns"]);
});

test("sandbox isolation succeeds on a capable host (otherwise explicitly skipped)",async(t)=>{
  const root=await mkdtemp(join(tmpdir(),"ff-sandbox-test-"));
  try {
    const store=new ProposalStore(root);
    const source="import unittest, os\nclass Probe(unittest.TestCase):\n def test_isolation(self):\n  assert os.getcwd() == '/workspace'\n  with open('/proc/self/status') as f: status=f.read()\n  assert 'NoNewPrivs:\t1' in status\n  assert not os.path.exists('/home/agent')\n  self.assertRaises(OSError, open, 'host-owned', 'w')\n  self.assertRaises(OSError, open, '/dev/owned', 'w')\n  try:\n   pid=os.fork()\n  except OSError:\n   pass\n  else:\n   if pid == 0: os._exit(0)\n   os.waitpid(pid,0)\n   self.fail('fork limit not enforced')\n";
    await writeFile(join(root,"test_probe.py"),source);
    await writeFile(join(root,".env"),"never mount this credential");
    const request={command:"python3",args:["-m","unittest","discover"]};
    const denied=await runSandboxTerminal(store,request,async()=>false);
    assert.ok(["denied","unsupported"].includes(denied.status));
    const approvals: import("../terminal.js").TerminalRequest[]=[];
    const result=await runSandboxTerminal(store,request,async r=>{approvals.push(r);return true;});
    // Never count fail-closed execution as successful isolation. Only narrowly
    // recognized host limitations can skip; argument errors and fixture failures
    // must fail. CI/release verification can require actual execution explicitly.
    const hostUnavailable = result.status === "unsupported" &&
      /requires Linux bubblewrap|requires a non-root user|Required sandbox runtime is unavailable/.test(result.stderr);
    const namespaceDenied = result.status === "failed" &&
      /^bwrap: (?:loopback: Failed to create NETLINK_ROUTE socket: Operation not permitted|Creating new namespace failed: Operation not permitted|No permissions to create new namespace)/m.test(result.stderr);
    if(result.status === "failed") assert.match(result.stderr,/No host fallback/);
    const approval=approvals[0];
    if(approval){assert.equal(approval.execution,"sandbox");assert.ok(Object.isFrozen(approval.args));}
    assert.equal(await readFile(join(root,"test_probe.py"),"utf8"),source);
    await assert.rejects(readFile(join(root,"host-owned")),/ENOENT/);
    if ((hostUnavailable || namespaceDenied) && process.env.FAKEFOUNDY_REQUIRE_SANDBOX !== "1") {
      t.skip(`Host cannot run sandbox; isolation NOT verified: ${result.stderr.split("\n")[0]}`);
      return;
    }
    assert.equal(result.status,"completed",result.stderr);
    assert.equal(result.exitCode,0);
    assert.match(result.stderr,/Ran 1 test/);
    assert.match(result.stderr,/OK/);
    assert.equal(approvals.length,1);
  }finally{await rm(root,{recursive:true,force:true});}
});


test("snapshot canonicalizes symlink workspace roots and never overwrites original proposals",async()=>{
  const parent=await mkdtemp(join(tmpdir(),"ff-snapshot-escape-"));
  const actual=join(parent,"real"),alias=join(parent,"alias"),snapshot=join(parent,"snapshot");
  try {
    await mkdir(actual);await mkdir(snapshot);await symlink(actual,alias);
    await writeFile(join(actual,"a.py"),"before");
    const store=new ProposalStore(alias);
    await store.proposePatch("a.py","before","after");
    await prepareSnapshot(store,snapshot);
    assert.equal(await readFile(join(snapshot,"a.py"),"utf8"),"after");
    assert.equal(await readFile(join(actual,"a.py"),"utf8"),"before");
    assert.equal(await readFile(join(alias,"a.py"),"utf8"),"before");
  }finally{await rm(parent,{recursive:true,force:true});}
});

test("snapshot rejects traversal even if a compromised discovery result supplies it",async()=>{
  const parent=await mkdtemp(join(tmpdir(),"ff-snapshot-path-"));
  const root=join(parent,"workspace"),snapshot=join(parent,"snapshot");
  try {
    await mkdir(root);await mkdir(snapshot);await writeFile(join(root,"a.py"),"keep");
    const store=new ProposalStore(root);
    store.discover=async()=>({files:["../workspace/a.py"],truncated:false});
    await assert.rejects(prepareSnapshot(store,snapshot),/escapes/);
    assert.equal(await readFile(join(root,"a.py"),"utf8"),"keep");
  }finally{await rm(parent,{recursive:true,force:true});}
});


test("snapshot rejects stale staged proposals instead of testing outdated content",async()=>{
  const parent=await mkdtemp(join(tmpdir(),"ff-snapshot-stale-"));
  const root=join(parent,"workspace"),snapshot=join(parent,"snapshot");
  try {
    await mkdir(root);await mkdir(snapshot);await writeFile(join(root,"a.py"),"before");
    const store=new ProposalStore(root);await store.proposePatch("a.py","before","staged");
    await writeFile(join(root,"a.py"),"user changed");
    await assert.rejects(prepareSnapshot(store,snapshot),/changed since proposal/);
    assert.equal(await readFile(join(root,"a.py"),"utf8"),"user changed");
  }finally{await rm(parent,{recursive:true,force:true});}
});


test("snapshot preserves bounded binary fixtures exactly, excludes secret and symlink files",async()=>{
  const parent=await mkdtemp(join(tmpdir(),"ff-snapshot-binary-"));
  const root=join(parent,"workspace"),snapshot=join(parent,"snapshot");
  try {
    await mkdir(root);await mkdir(snapshot);
    const png=Buffer.from([137,80,78,71,13,10,26,10,0,255,128,1]);
    await writeFile(join(root,"asset.png"),png);
    await writeFile(join(root,".env"),"secret");
    await symlink(join(root,"asset.png"),join(root,"alias.png"));
    const store=new ProposalStore(root);
    await prepareSnapshot(store,snapshot);
    assert.deepEqual(await readFile(join(snapshot,"asset.png")),png);
    await assert.rejects(readFile(join(snapshot,".env")),/ENOENT/);
    await assert.rejects(readFile(join(snapshot,"alias.png")),/ENOENT/);
    await assert.rejects(store.read("asset.png"),/Binary/);
    store.discover=async()=>({files:["alias.png"],truncated:false});
    await assert.rejects(prepareSnapshot(store,snapshot),/symbolic links/);
    store.discover=async()=>({files:[".env"],truncated:false});
    await assert.rejects(prepareSnapshot(store,snapshot),/Sensitive/);
  }finally{await rm(parent,{recursive:true,force:true});}
});

test("snapshot byte reader rejects oversized regular files before copying",async()=>{
  const parent=await mkdtemp(join(tmpdir(),"ff-snapshot-large-"));
  const root=join(parent,"workspace"),snapshot=join(parent,"snapshot");
  try {
    await mkdir(root);await mkdir(snapshot);await writeFile(join(root,"large.bin"),Buffer.alloc(1024*1024+1));
    const store=new ProposalStore(root);
    store.discover=async()=>({files:["large.bin"],truncated:false});
    await assert.rejects(prepareSnapshot(store,snapshot),/1 MiB/);
    await assert.rejects(readFile(join(snapshot,"large.bin")),/ENOENT/);
  }finally{await rm(parent,{recursive:true,force:true});}
});

test("snapshot rejects a file changed after initial proposal validation",async()=>{
  const parent=await mkdtemp(join(tmpdir(),"ff-snapshot-race-"));
  const root=join(parent,"workspace"),snapshot=join(parent,"snapshot");
  try {
    await mkdir(root);await mkdir(snapshot);await writeFile(join(root,"a.py"),"original");
    const store=new ProposalStore(root);await store.proposePatch("a.py","original","staged");
    const read=store.read.bind(store);
    store.read=async(path:string)=>{
      const before=await read(path);
      // A user edit lands after validation reads, before descriptor copy.
      await writeFile(join(root,"a.py"),"new user edit");
      return before;
    };
    await assert.rejects(prepareSnapshot(store,snapshot),/changed while preparing snapshot/);
    await assert.rejects(readFile(join(snapshot,"a.py")),/ENOENT/);
    assert.equal(await readFile(join(root,"a.py"),"utf8"),"new user edit");
  }finally{await rm(parent,{recursive:true,force:true});}
});
