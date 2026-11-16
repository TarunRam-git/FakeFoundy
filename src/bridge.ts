import { createServer, Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ProposalStore } from './proposals.js';
export async function startBridge(store: ProposalStore, port = 31337) {
  const token = randomBytes(32).toString('hex');
  const active = new Set<McpServer>();
  const server: Server = createServer(async (req, res) => {
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const mcp = new McpServer({ name: 'fakefoundy-editor', version: '0.1.0' });
    active.add(mcp);
    mcp.registerTool('read_file', {description: 'Read an existing workspace file', inputSchema: {path:z.string()}, annotations:{readOnlyHint:true}}, async ({path}) => ({content:[{type:'text',text:await store.read(path)}]}));
    mcp.registerTool('propose_edit', {description: 'Stage replacement content for explicit editor review; never writes to disk', inputSchema:{path:z.string(),content:z.string()}, annotations:{readOnlyHint:true}}, async ({path,content}) => {
      const p=await store.propose(path,content);
      return {content:[{type:'text',text:JSON.stringify({proposalId:p.id,status:'pending_editor_review'})}]};
    });
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
    res.on('close', () => { void mcp.close(); active.delete(mcp); });
    try { await mcp.connect(transport); await transport.handleRequest(req,res); }
    catch { if (!res.headersSent) res.writeHead(500).end('MCP request failed'); }
  });
  await new Promise<void>((ok,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',ok);});
  const address=server.address();
  return {url:`http://127.0.0.1:${typeof address==='object' && address ? address.port : port}/mcp`,token,close:async()=>{for(const s of active) await s.close(); await new Promise<void>(ok=>server.close(()=>ok()));}};
}
