import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,symlink,rm,realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ProposalStore} from "../proposals.js";
import {runReadOnlyTerminal,TERMINAL_OUTPUT_BYTES} from "../terminal.js";
import {startBridge} from "../bridge.js";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("terminal fails closed without approval and unsupported commands never request it",async()=>{
  const store=new ProposalStore("/nonexistent-no-read-before-approval");
  assert.equal((await runReadOnlyTerminal(store,{command:"pwd",args:[]})).status,"denied");
  assert.equal((await runReadOnlyTerminal(store,{command:"pwd",args:[]},async()=>false)).status,"denied");
  let approvals=0;
  for(const request of [
    {command:"sh",args:["-c","touch owned"]},
    {command:"pwd;touch owned",args:[]},
    {command:"npm",args:["test"]},
    {command:"python",args:["-c","print('secret')"]},
    {command:"curl",args:["https://example.com"]},
    {command:"cat",args:["../secret"]},
    {command:"cat",args:["/etc/passwd"]},
    {command:"cat",args:["-n","file"]},
    {command:"cat",args:["file\nsecond"]},
    {command:"ls",args:["-a"]},
  ]) assert.equal((await runReadOnlyTerminal(store,request,async()=>{approvals++;return true;})).status,"unsupported");
  assert.equal(approvals,0);
});

test("approved terminal recipes confine paths, block secrets and bound output without writes",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ff-terminal-"));
  const outside=await mkdtemp(join(tmpdir(),"ff-terminal-out-"));
  try {
    const store=new ProposalStore(root), approve=async()=>true;
    await writeFile(join(root,"hello.txt"),"before\n");
    await writeFile(join(root,".env"),"private");
    await writeFile(join(outside,"secret"),"private");
    await symlink(join(outside,"secret"),join(root,"outside.txt"));
    await symlink(join(root,".env"),join(root,"alias.txt"));
    assert.equal((await runReadOnlyTerminal(store,{command:"pwd",args:[]},approve)).stdout,(await realpath(root))+"\n");
    assert.equal((await runReadOnlyTerminal(store,{command:"ls",args:[]},approve)).stdout,"hello.txt\n");
    assert.equal((await runReadOnlyTerminal(store,{command:"cat",args:["hello.txt"]},approve)).stdout,"before\n");
    for(const path of [".env","outside.txt","alias.txt"])
      await assert.rejects(runReadOnlyTerminal(store,{command:"cat",args:[path]},approve),/Sensitive|inside/);
    await writeFile(join(root,"unicode.txt"),"🐈".repeat(10000));
    const long=await runReadOnlyTerminal(store,{command:"cat",args:["unicode.txt"]},approve);
    assert.equal(long.truncated,true);
    assert.ok(Buffer.byteLength(long.stdout)<=TERMINAL_OUTPUT_BYTES);
    assert.ok(!long.stdout.includes("�"));
    assert.equal(await readFile(join(root,"hello.txt"),"utf8"),"before\n");
    assert.equal(store.list().length,0);
    // A file name is data, never shell syntax. It cannot execute a second command.
    await writeFile(join(root,"literal;echo.txt"),"literal");
    assert.equal((await runReadOnlyTerminal(store,{command:"cat",args:["literal;echo.txt"]},approve)).stdout,"literal");
  } finally {await rm(root,{recursive:true});await rm(outside,{recursive:true});}
});

test("terminal freezes approved argv before awaiting approval",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ff-terminal-copy-"));
  try {
    await writeFile(join(root,"good.txt"),"good");
    const input={command:"cat",args:["good.txt"]};
    const result=await runReadOnlyTerminal(new ProposalStore(root),input,async(request)=>{
      input.args[0]=".env";input.command="sh";
      assert.deepEqual(request,{command:"cat",args:["good.txt"]});
      assert.ok(Object.isFrozen(request.args));return true;
    });
    assert.equal(result.stdout,"good");
  } finally {await rm(root,{recursive:true});}
});

test("terminal MCP uses editor approval and does not expose an arbitrary execution path",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ff-terminal-mcp-"));
  const approved:string[]=[];
  const bridge=await startBridge(new ProposalStore(root),0,{approveTerminal:async r=>{approved.push(r.command);return r.command==="pwd";}});
  const client=new Client({name:"terminal-test",version:"1"});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
    const ok=await client.callTool({name:"run_terminal",arguments:{command:"pwd"}});
    assert.equal(ok.isError,false);
    const denied=await client.callTool({name:"run_terminal",arguments:{command:"ls"}});
    assert.equal(denied.isError,true);
    const unsupported=await client.callTool({name:"run_terminal",arguments:{command:"sh",args:["-c","touch owned"]}});
    assert.equal(unsupported.isError,true);
    assert.deepEqual(approved,["pwd","ls"]);
  } finally {await client.close();await bridge.close();await rm(root,{recursive:true});}
});
