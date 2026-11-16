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
    mcp.registerTool("fakefoundy_read_file", {
      description: "Authoritative editor file reader (not a runtime/built-in read_file). Returns exact small excerpts, never ellipses. Use start_line/max_lines, then follow next.start_line/start_column until has_more=false. Columns count UTF-16 code units; at most 8000 per response. Prefer this over generic read_file or cat.",
      inputSchema: {path:z.string(),start_line:z.number().int().min(1).default(1),max_lines:z.number().int().min(1).max(80).default(40),start_column:z.number().int().min(0).default(0)},
      annotations:{readOnlyHint:true},
    }, async ({path,start_line,max_lines,start_column})=>({content:[{type:"text",text:JSON.stringify(await store.readRange(path,start_line,max_lines,start_column))}]}));
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
    mcp.registerTool("propose_selection", {
      description: "INLINE EDITS ONLY: supply new_text containing only the replacement for the selected code. The editor remembers the exact selected file and old text; do not repeat either. Preserves all surrounding file content and stages for review; never writes to disk.",
      inputSchema: {new_text:z.string()},
      annotations:{readOnlyHint:true},
    }, async ({new_text})=>{
      const p=await store.proposeSelection(new_text);
      return {content:[{type:"text",text:JSON.stringify({proposalId:p.id,status:"pending_editor_review",hunks:p.hunks.map(h=>({id:h.id,startLine:h.start+1,deletedLines:h.deleteCount}))})}]};
    });
    mcp.registerTool("propose_patch", {
      description: "Stage an exact, unique old_text replacement with new_text. Multiple disjoint ORIGINAL-file ranges compose into one reviewable proposal; overlaps are rejected. Read tools return original disk content, not pending changes. old_text/new_text must contain actual newlines in the parsed strings, not literal backslash-n text; JSON-encode once. Copy a short unique original anchor exactly. Correct a failed argument rather than repeating discovery. For inline edits prefer propose_selection, which remembers the exact selected text. Never writes to disk; explicit editor review required.",
      inputSchema: {path:z.string(),old_text:z.string().min(1),new_text:z.string()},
      annotations:{readOnlyHint:true},
    }, async ({path,old_text,new_text})=>{
      const p=await store.proposePatch(path,old_text,new_text);
      return {content:[{type:"text",text:JSON.stringify({proposalId:p.id,status:"pending_editor_review",hunks:p.hunks.map(h=>({id:h.id,startLine:h.start+1,deletedLines:h.deleteCount}))})}]};
    });
    // Legacy name remains only to return an actionable error to older prompts.
    mcp.registerTool("propose_edit", {
      description: "DISABLED: full-file replacement is unsafe for existing files. Use propose_patch for bounded, disjoint original-text replacements or propose_selection for inline edits.",
      inputSchema: {path:z.string(),content:z.string()},
      annotations:{readOnlyHint:true},
    }, async ()=>({isError:true,content:[{type:"text",text:"Full-file replacement is disabled. Use propose_patch on bounded original-text ranges; disjoint patches compose. For inline edits use propose_selection. Never delete unrelated code or tests to work around an edit conflict."}]}));
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
