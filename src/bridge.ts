import { createServer, Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ProposalStore } from "./proposals.js";
import { runReadOnlyTerminal, TerminalApproval } from "./terminal.js";
export async function startBridge(store: ProposalStore, port = 31337, options: {approveTerminal?: TerminalApproval; terminalSignal?: () => AbortSignal | undefined} = {}) {
  const terminalLifetime = new AbortController();
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
      description: "Find a literal in the workspace, or set path to search one named file. Returns line numbers and matching text.",
      inputSchema: {query:z.string().min(1),path:z.string().optional(),limit:z.number().int().min(1).max(100).optional()},
      annotations:{readOnlyHint:true},
    }, async ({query,limit,path})=>({content:[{type:"text",text:JSON.stringify(await store.search(query,limit,path))}]}));
    mcp.registerTool("read_related_files", {
      description: "Inspect up to three related files in one call. Small files are returned whole. For large files get a line-numbered outline and exact head/tail excerpts, or set query or start_line to show exact text near a symbol, heading or line. Make targeted follow-up reads together.",
      inputSchema: {files:z.array(z.object({path:z.string().min(1).max(512),start_line:z.number().int().min(1).optional(),query:z.string().min(1).max(200).optional()})).min(1).max(3)},
      annotations:{readOnlyHint:true},
    }, async ({files}) => {
      const content = [];
      for (const file of files) {
        const source = await store.read(file.path);
        const text = relatedExcerpt(source, file.query, file.start_line);
        content.push({type:"text" as const, text:file.path + "\n" + text});
      }
      return {content};
    });
    mcp.registerTool("fakefoundy_read_file", {
      description: "Authoritative editor file reader (not a runtime/built-in read_file). Returns exact small excerpts, never ellipses. Use start_line/max_lines, use the next cursor only if the needed anchor continues onto the next page. Columns count UTF-16 code units; at most 8000 per response. Prefer this over generic read_file or cat.",
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
    mcp.registerTool("review_staged_edits", {
      description: "After all patches are staged, request native TrueForge approval of the batch. Shows editor diffs; approval keeps proposals staged, never applies or saves files. Call before finishing; respect denial.",
      inputSchema: {}, annotations:{readOnlyHint:true},
    }, async ()=>({content:[{type:"text",text:JSON.stringify({status:"reviewed_pending_explicit_editor_apply",proposalCount:store.list().length})}]}));
    // Legacy name remains only to return an actionable error to older prompts.
    mcp.registerTool("propose_edit", {
      description: "DISABLED: full-file replacement is unsafe for existing files. Use propose_patch for bounded, disjoint original-text replacements or propose_selection for inline edits.",
      inputSchema: {path:z.string(),content:z.string()},
      annotations:{readOnlyHint:true},
    }, async ()=>({isError:true,content:[{type:"text",text:"Full-file replacement is disabled. Use propose_patch on bounded original-text ranges; disjoint patches compose. For inline edits use propose_selection. Never delete unrelated code or tests to work around an edit conflict."}]}));
    mcp.registerTool("run_terminal", {
      description: "Explicit-approval terminal: read-only pwd/ls/cat; or python3 -m pytest/unittest in mandatory Linux sandbox using a filtered workspace snapshot with staged patches. No shell, network, host writes, credential mounts, or dependency installation. Test code executes only after approval. Missing sandbox/dependencies fail closed.",
      inputSchema: {command:z.string().max(64),args:z.array(z.string().max(1024)).max(16).default([])},
      annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
    }, async ({command,args})=>{
      const result=await runReadOnlyTerminal(store,{command,args},options.approveTerminal, AbortSignal.any([terminalLifetime.signal, ...[options.terminalSignal?.()].filter((s): s is AbortSignal=>!!s)]));
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
      terminalLifetime.abort();
      for (const s of active) await s.close();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

// Three excerpts plus paths and MCP framing stay below TrueForge's 24k response ceiling.
function relatedExcerpt(source: string, query?: string, startLine?: number): string {
  if (!query && !startLine && source.length <= 6400) return source;
  const lines = source.split("\n");
  if (query || startLine) {
    const offset = (startLine ?? 1) - 1;
    if (offset >= lines.length) return "Start line is outside this file.";
    const term = query?.toLowerCase();
    const line = term ? lines.findIndex((value, i) => i >= offset && value.toLowerCase().includes(term)) : offset;
    if (line < 0) return "No line matches the supplied query.";
    const first = term ? Math.max(0, line - 4) : line;
    return `From line ${first + 1}, match at ${line + 1}:\n` +
      lines.slice(first, line + 65).join("\n").slice(0, 6200);
  }
  const outline: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:(?:async )?def |class |(?:export )?(?:async )?function |#{1,4} )/.test(lines[i]) ||
        (lines[i].trim() && /^[=~-]{3,}\s*$/.test(lines[i + 1] ?? ""))) {
      outline.push(`${i + 1}: ${lines[i].trim().slice(0, 110)}`);
    }
  }
  const index = outline.join("\n");
  const summary = index.length <= 3500 ? index : index.slice(0, 1500) + "\n...\n" + index.slice(-1950);
  return `Outline (line numbers):\n${summary}\nFirst characters:\n${source.slice(0, 950)}\nLast characters:\n${source.slice(-1750)}`;
}
