import assert from 'node:assert/strict';
// Tests the real TrueForge runtime with a deterministic LOCAL fake model.
// This proves transport/tool wiring, not real-model task-solving ability.
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { ProposalStore } from "../dist/proposals.js";
import { startBridge } from "../dist/bridge.js";
import { runTurn } from "../dist/client.js";
const root = await mkdtemp(join(tmpdir(), "ff-smoke-"));
await writeFile(join(root, "hello.txt"), "before");
const store = new ProposalStore(root);
const bridge = await startBridge(store, 0);
let calls = 0;
const model = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  calls++;
  const tools = body.tools ?? [];
  const desired = ["read_related_files","propose_patch","review_staged_edits"][calls - 1];
  const tool = tools.find((t) => t.function?.name?.endsWith(desired));
  const delta =
    calls <= 3 && tool
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${calls}`,
              type: "function",
              function: {
                name: tool.function.name,
                arguments: JSON.stringify(
                  calls === 1
                    ? { files: [{path: "hello.txt"}] }
                    : calls === 2 ? {path: "hello.txt", old_text: "before", new_text: "after"} : {},
                ),
              },
            },
          ],
        }
      : { role: "assistant", content: "Edit staged for your review." };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [d, reason] of [
    [delta, null],
    [{}, calls <= 3 && tool ? "tool_calls" : "stop"],
  ])
    res.write(
      `data: ${JSON.stringify({ id: "local-test", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: d, finish_reason: reason }] })}\n\n`,
    );
  res.end("data: [DONE]\n\n");
});
await new Promise((ok) => model.listen(0, "127.0.0.1", ok));
const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_URL ?? "http://127.0.0.1:8790",
  maxRetries: 0,
});
try {
  await client.settings.modelProviders.createOrUpdate({
    manifest: {
      type: "custom",
      name: "fakefoundy-smoke",
      baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
      auth: { apiKey: "local-test-not-a-secret" },
      models: [{ name: "test", modelId: "test", properties: {} }],
    },
  });
  await client.settings.mcpServers.createOrUpdate({
    manifest: {
      name: "fakefoundy-editor",
      description: "Local smoke bridge",
      type: "remote",
      url: bridge.url,
      auth: {
        type: "header",
        headers: { Authorization: `Bearer ${bridge.token}` },
      },
    },
  });
  let approved = false;
  let events = 0;
  const types = new Set();
  const session = await runTurn(
    client,
    "fakefoundy-smoke/test",
    "Read hello.txt then propose replacing its contents with after.",
    (e) => {
      events++;
      types.add(e.type);
    },
    {onApproval: async () => {
      assert.equal(store.list()[0]?.after, "after");
      assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "before");
      approved = true;
      return true;
    }, hasUnreviewedEdits: () => store.list().length > 0 && !approved},
  );
  assert.ok(approved);
  assert.ok(types.has("model.message.delta"));
  assert.equal(calls, 4);
  if (
    store.list().length !== 1 ||
    (await readFile(join(root, "hello.txt"), "utf8")) !== "before"
  )
    throw new Error(
      `Expected one staged proposal and unchanged file; got ${store.list().length}; events ${[...types]}`,
    );
  console.log(
    JSON.stringify(
      {
        session,
        events,
        eventTypes: [...types],
        modelCalls: calls,
        proposalStaged: true,
        workspaceUnchanged: true,
        provider: "deterministic-local-test-double",
      },
      null,
      2,
    ),
  );
} finally {
  await bridge.close();
  await new Promise((ok) => model.close(ok));
  await rm(root, { recursive: true });
}
