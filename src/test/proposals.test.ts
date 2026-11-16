import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProposalStore } from "../proposals.js";
import { startBridge } from "../bridge.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
test("stages without writes, rejects, detects stale edits, confines paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "ff-"));
  const outside = await mkdtemp(join(tmpdir(), "outside-"));
  try {
    await writeFile(join(root, "a.txt"), "before");
    await writeFile(join(outside, "secret"), "secret");
    const s = new ProposalStore(root);
    const p = await s.propose("a.txt", "after");
    assert.equal(await s.read("a.txt"), "before");
    s.reject(p.id);
    assert.equal(s.list().length, 0);
    const q = await s.propose("a.txt", "after");
    await writeFile(join(root, "a.txt"), "changed");
    await assert.rejects(s.apply(q.id), /changed/);
    await symlink(join(outside, "secret"), join(root, "link"));
    await assert.rejects(s.read("link"), /inside/);
    await assert.rejects(s.read(join(outside, "secret")), /inside/);
  } finally {
    await rm(root, { recursive: true });
    await rm(outside, { recursive: true });
  }
});
test("real MCP transport reads and stages, rejects unauthenticated requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "ff-mcp-"));
  await writeFile(join(root, "a.txt"), "before");
  const store = new ProposalStore(root);
  const bridge = await startBridge(store, 0);
  const client = new Client({ name: "integration-test", version: "1" });
  try {
    assert.equal((await fetch(bridge.url, { method: "POST" })).status, 401);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.url), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
      }),
    );
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((t) => t.name),
      ["list_files", "search_files", "fakefoundy_read_file", "read_file", "propose_selection", "propose_patch", "propose_edit", "run_terminal"],
    );
    const range = await client.callTool({name:"fakefoundy_read_file",arguments:{path:"a.txt",start_line:1,max_lines:1}});
    const rangeContent = range.content as {type:string;text?:string}[];
    assert.deepEqual(JSON.parse(rangeContent[0].text!), {path:"a.txt",start_line:1,start_column:0,text:"before",total_lines:1,has_more:false,next:null});
    store.setInlineScope({path:"a.txt",oldText:"before"});
    const blocked = await client.callTool({name:"propose_edit",arguments:{path:"a.txt",content:"snippet"}});
    assert.equal(blocked.isError,true);
    const patch = await client.callTool({name:"propose_selection",arguments:{new_text:"patched"}});
    assert.notEqual(patch.isError,true);
    assert.equal(store.list()[0].after,"patched");
    assert.equal(await readFile(join(root,"a.txt"),"utf8"),"before");
    store.reject(store.list()[0].id);
    store.setInlineScope();
    const full = await client.callTool({name:"propose_edit",arguments:{path:"a.txt",content:"after"}});
    assert.equal(full.isError,true);
    assert.equal(store.list().length,0);
    await client.callTool({name:"propose_patch",arguments:{path:"a.txt",old_text:"before",new_text:"after"}});
    assert.equal(store.list().length, 1);
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "before");
  } finally {
    await client.close();
    await bridge.close();
    await rm(root, { recursive: true });
  }
});

test("blocks sensitive paths and oversized files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ff-sensitive-"));
  try {
    const s = new ProposalStore(root);
    await writeFile(join(root, ".env"), "token=private");
    await writeFile(join(root, "large.txt"), Buffer.alloc(1024 * 1024 + 1));
    await symlink(join(root, ".env"), join(root, "alias.txt"));
    await assert.rejects(s.read(".env"), /Sensitive/);
    await assert.rejects(s.read("alias.txt"), /Sensitive/);
    await assert.rejects(s.read("large.txt"), /1 MiB/);
  } finally {
    await rm(root, { recursive: true });
  }
});
