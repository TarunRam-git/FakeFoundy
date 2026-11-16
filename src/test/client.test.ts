import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, createClient } from "../client.js";
function fakeClient(events: unknown[]) {
  return {
    sessions: {
      create: async () => ({ data: { id: "session-test" } }),
      createTurnStream: async function* () {
        yield* events;
      },
    },
  } as unknown as Parameters<typeof runTurn>[0];
}
test("turn accepts only terminal success and forwards streamed events", async () => {
  const seen: unknown[] = [];
  assert.equal(
    await runTurn(
      fakeClient([{ type: "turn.done", state: { status: "done" } }]),
      "test/model",
      "prompt",
      (e) => seen.push(e),
    ),
    "session-test",
  );
  assert.equal(seen.length, 1);
  await assert.rejects(
    runTurn(fakeClient([]), "test/model", "prompt", () => {}),
    /before terminal/,
  );
  await assert.rejects(
    runTurn(
      fakeClient([
        {
          type: "turn.done",
          state: { status: "error", message: "provider unavailable" },
        },
      ]),
      "test/model",
      "prompt",
      () => {},
    ),
    /provider unavailable/,
  );
  await assert.rejects(
    runTurn(
      fakeClient([{ type: "turn.done", state: { status: "cancelled" } }]),
      "test/model",
      "prompt",
      () => {},
    ),
    /cancelled/,
  );
});
test("client disallows non-local runtime URLs", async () => {
  await assert.rejects(createClient("https://example.com"), /local HTTP/);
});
