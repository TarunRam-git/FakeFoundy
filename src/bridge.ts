import { createServer, Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ProposalStore } from "./proposals.js";
import { runReadOnlyTerminal, TerminalApproval } from "./terminal.js";
export async function startBridge(store: ProposalStore, port = 31337, options: {approveTerminal?: TerminalApproval} = {}) {
  const token = randomBytes(32).toString("hex");
  const active = new Set<McpServer>();
  const server: Server = createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const mcp = new McpServer({ name: "fakefoundy-editor", version: "0.1.0" });
    active.add(mcp);
    mcp.registerTool("list_files", {
      description: "Discover workspace files by optional path substring; bounded, excludes hidden/generated directories and symlinks. Check truncated flag.",
      inputSchema: {query:z.string().optional(),limit:z.number().int().min(1).max(500).optional()},
      annotations:{readOnlyHint:true},
    }, async ({query,limit})=>({content:[{type:"text",text:JSON.stringify(await store.discover(query,limit))}]}));
    mcp.registerTool("search_files", {
      description: "Literal case-insensitive text search across discovered workspace files. Bounded results with line numbers; check truncated flag.",
      inputSchema: {query:z.string().min(1),limit:z.number().int().min(1).max(100).optional()},
      annotations:{readOnlyHint:true},
    }, async ({query,limit})=>({content:[{type:"text",text:JSON.stringify(await store.search(query,limit))}]}));
    mcp.registerTool(
      "read_file",
      {
        description: "Read an existing workspace file",
        inputSchema: { path: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ path }) => ({
        content: [{ type: "text", text: await store.read(path) }],
      }),
    );
    mcp.registerTool(
      "propose_edit",
      {
        description:
          "Stage replacement content for explicit editor review; never writes to disk",
        inputSchema: { path: z.string(), content: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ path, content }) => {
        const p = await store.propose(path, content);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                proposalId: p.id,
                status: "pending_editor_review",
                hunks: p.hunks.map(h=>({id:h.id,startLine:h.start+1,deletedLines:h.deleteCount})),
              }),
            },
          ],
        };
      },
    );
    mcp.registerTool("run_terminal", {
      description: "Approval-gated read-only terminal recipes, NOT a shell: pwd; ls (bounded recursive file inventory); cat with one relative workspace path. No flags, scripts, builds, network, or writes. Unsupported commands stay unsupported after approval.",
      inputSchema: {command:z.string().max(64),args:z.array(z.string().max(1024)).max(8).default([])},
      annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    }, async ({command,args})=>{
      const result=await runReadOnlyTerminal(store,{command,args},options.approveTerminal);
      return {isError:result.status!=="completed",content:[{type:"text",text:JSON.stringify(result)}]};
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void mcp.close();
      active.delete(mcp);
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end("MCP request failed");
    }
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", ok);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}/mcp`,
    token,
    close: async () => {
      for (const s of active) await s.close();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}
