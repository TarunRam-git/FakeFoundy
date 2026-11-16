import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProposalStore} from '../proposals.js';
import {startBridge} from '../bridge.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
test('stages without writes, rejects, detects stale edits, confines paths',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ff-'));const outside=await mkdtemp(join(tmpdir(),'outside-'));
 try {await writeFile(join(root,'a.txt'),'before');await writeFile(join(outside,'secret'),'secret');
 const s=new ProposalStore(root);const p=await s.propose('a.txt','after');assert.equal(await s.read('a.txt'),'before');
 s.reject(p.id);assert.equal(s.list().length,0);
 const q=await s.propose('a.txt','after');await writeFile(join(root,'a.txt'),'changed');await assert.rejects(s.apply(q.id),/changed/);
 await symlink(join(outside,'secret'),join(root,'link'));await assert.rejects(s.read('link'),/inside/);
 await assert.rejects(s.read(join(outside,'secret')),/inside/);
 }finally{await rm(root,{recursive:true});await rm(outside,{recursive:true});}
});
test('real MCP transport reads and stages, rejects unauthenticated requests',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ff-mcp-'));await writeFile(join(root,'a.txt'),'before');
 const store=new ProposalStore(root);const bridge=await startBridge(store,0);
 const client=new Client({name:'integration-test',version:'1'});
 try {assert.equal((await fetch(bridge.url,{method:'POST'})).status,401);
 await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 const listed=await client.listTools();assert.deepEqual(listed.tools.map(t=>t.name),['read_file','propose_edit']);
 await client.callTool({name:'propose_edit',arguments:{path:'a.txt',content:'after'}});
 assert.equal(store.list().length,1);assert.equal(await readFile(join(root,'a.txt'),'utf8'),'before');
 }finally{await client.close();await bridge.close();await rm(root,{recursive:true});}
});
