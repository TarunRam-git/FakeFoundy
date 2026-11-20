import { createServer, Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { relative } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ProposalStore } from "./proposals.js";
import { runReadOnlyTerminal, TerminalApproval } from "./terminal.js";
export async function startBridge(store: ProposalStore, port = 31337, options: {approveTerminal?: TerminalApproval; terminalSignal?: () => AbortSignal | undefined} = {}) {
  const terminalLifetime = new AbortController();
  const terminalSignal = () => AbortSignal.any([terminalLifetime.signal,
    ...[options.terminalSignal?.()].filter((signal): signal is AbortSignal => !!signal)]);
  const retainedProposals = new Set(store.list().map(proposal => proposal.id));
  // Review may be called twice with the same contents. Keep the already approved
  // test result until a proposal changes, rather than prompting the user again.
  let verifiedBatch: ReturnType<ProposalStore["list"]> = [];
  let reviewedTests: {path: string; name: string; status: string; output: string}[] = [];
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
    const mcp = new McpServer({ name: "patchlight-editor", version: "0.1.0" });
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
      description: "Inspect up to three related files in one call. Small files are returned whole. For large files get a line-numbered outline and exact head/tail excerpts. Set start_line for a range or query for a short literal; if both are set, start_line is a search hint. A missing match returns an outline with usable line numbers. Make targeted follow-up reads together.",
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
    mcp.registerTool("patchlight_read_file", {
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
      description: "Stage an exact, unique original old_text replacement with new_text. Disjoint original ranges compose. To correct a staged patch, set replace_existing. You can replace one exact unique snippet within the staged replacement, or reuse its original old_text to replace that entire staged range. Other overlaps are rejected. Reads show original disk text. Use actual newlines in parsed strings. Never writes to disk; editor review required.",
      inputSchema: {path:z.string(),old_text:z.string().min(1),new_text:z.string(),replace_existing:z.boolean().optional()},
      annotations:{readOnlyHint:true},
    }, async ({path,old_text,new_text,replace_existing})=>{
      const p=await store.proposePatch(path,old_text,new_text,replace_existing);
      return {content:[{type:"text",text:JSON.stringify({proposalId:p.id,status:"pending_editor_review",hunks:p.hunks.map(h=>({id:h.id,startLine:h.start+1,deletedLines:h.deleteCount}))})}]};
    });
    mcp.registerTool("review_staged_edits", {
      description: "When the batch is ready, request native TrueForge approval. The editor can run new Python tests in the approved Linux sandbox as part of review. Fix reported test failures and request review of the revised batch. Approval keeps proposals staged; disk remains unchanged.",
      inputSchema: {}, annotations:{readOnlyHint:true},
    }, async () => {
      const batch = store.list().filter(proposal => !retainedProposals.has(proposal.id));
      if (process.platform === "linux" && options.approveTerminal &&
          (batch.length !== verifiedBatch.length || batch.some((proposal, index) => proposal !== verifiedBatch[index]))) {
        const tests = batch.flatMap(proposal => {
          const path = relative(store.root, proposal.path);
          if (!/(?:^|[/\\])(?:test_[^/\\]+|[^/\\]+_test)\.py$/.test(path)) return [];
          const names = new Set(proposal.hunks.flatMap(hunk => [...hunk.after.matchAll(/^\s*(?:async )?def (test_\w+)\(/gm)].map(match => match[1])));
          return [...names].map(name => ({path, name}));
        }).slice(0, 3);
        const results: typeof reviewedTests = [];
        for (const test of tests) {
          const result = await runReadOnlyTerminal(store, {command:"python3",args:["-m","pytest",test.path,"-k",test.name,"-q"]},
            options.approveTerminal, terminalSignal());
          results.push({...test,status:result.status,output:(result.stdout + "\n" + result.stderr).trim().slice(-3000)});
        }
        verifiedBatch = batch;
        reviewedTests = results;
      }
      const failed = reviewedTests.some(test => test.status === "failed");
      return {isError:failed,content:[{type:"text",text:JSON.stringify({
        status:failed ? "staged_tests_failed" : "reviewed_pending_explicit_editor_apply",proposalCount:batch.length,
        tests:reviewedTests,
        next:failed ? "The edits remain staged. Fix the failing test or implementation, then request review of the revised patches." :
          "Summarize the staged files and finish the turn. The editor handles Apply.",
      })}]};
    });
    // Legacy name remains only to return an actionable error to older prompts.
    mcp.registerTool("propose_edit", {
      description: "DISABLED: full-file replacement is unsafe for existing files. Use propose_patch for bounded, disjoint original-text replacements or propose_selection for inline edits.",
      inputSchema: {path:z.string(),content:z.string()},
      annotations:{readOnlyHint:true},
    }, async ()=>({isError:true,content:[{type:"text",text:"Full-file replacement is disabled. Use propose_patch on bounded original-text ranges; disjoint patches compose. For inline edits use propose_selection. Never delete unrelated code or tests to work around an edit conflict."}]}));
    mcp.registerTool("run_terminal", {
      description: "Explicit-approval terminal: read-only pwd/ls/cat or sandboxed Python tests. For pytest send command python3 and args [\"-m\",\"pytest\",\"tests/test_example.py::test_example\",\"-q\"]. Tests see staged patches in a filtered Linux snapshot. No shell, network, host writes, credential mounts, or dependency installation.",
      inputSchema: {command:z.string().max(64).describe("Executable name alone, with no flags"),args:z.array(z.string().max(1024)).max(16).default([])},
      annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
    }, async ({command,args})=>{
      const result=await runReadOnlyTerminal(store,{command,args},options.approveTerminal, terminalSignal());
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
  let fallback = "";
  if (query || startLine) {
    const offset = (startLine ?? 1) - 1;
    const term = query?.toLowerCase();
    let line = term ? lines.findIndex((value, i) => i >= offset && value.toLowerCase().includes(term)) : offset;
    if (term && line < 0 && offset > 0) {
      line = lines.findIndex(value => value.toLowerCase().includes(term));
    }
    if (line >= 0 && line < lines.length) {
      const first = term ? Math.max(0, line - 4) : line;
      return `From line ${first + 1}, match at ${line + 1}:\n` +
        lines.slice(first, line + 65).join("\n").slice(0, 6200);
    }
    fallback = (offset >= lines.length ? "Start line is outside this file." : "No line matches the supplied query.") +
      " Use a real heading or line number from the outline below.\n";
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
  return `${fallback}Outline (line numbers):\n${summary}\nFirst characters:\n${source.slice(0, 850)}\nLast characters:\n${source.slice(-1700)}`;
}
