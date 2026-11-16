import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, createClient } from "../client.js";
function fakeClient(events: unknown[]) {
  return {
    sessions: {
      cancel: async () => ({}),
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

test("falls back only once, rolls back before retry, and uses configured model", async () => {
  const calls: string[] = [];
  let attempt = 0;
  const client = { sessions: {
    create: async (request: any) => {
      calls.push(request.agent.spec.model.name);
      return { data: { id: `session-${++attempt}` } };
    },
    createTurnStream: async function* () {
      yield { type: "turn.done", state: attempt === 1
        ? { status: "error", message: "quota exceeded" } : { status: "done" } };
    },
  } } as unknown as Parameters<typeof runTurn>[0];
  assert.equal(await runTurn(client, "primary", "prompt", () => {}, {
    fallbackModel: "secondary", onAttemptFailed: () => { calls.push("rollback"); },
  }), "session-2");
  assert.deepEqual(calls, ["primary", "rollback", "secondary"]);
});

test("abort cancels the remote session and never starts fallback", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const client = { sessions: {
    create: async () => { calls.push("create"); return { data: { id: "s" } }; },
    createTurnStream: async function* () {
      controller.abort();
      yield { type: "turn.started" };
    },
    cancel: async (id: string) => { calls.push(`cancel:${id}`); },
  } } as unknown as Parameters<typeof runTurn>[0];
  await assert.rejects(runTurn(client, "primary", "prompt", () => {}, {
    signal: controller.signal, fallbackModel: "secondary",
    onAttemptFailed: () => { calls.push("rollback"); },
  }), /cancelled/);
  assert.deepEqual(calls, ["create", "cancel:s", "rollback"]);
});

test("does not fallback when remote cancellation cannot be confirmed", async () => {
  let attempts = 0;
  const client = { sessions: {
    create: async () => { attempts++; return { data: { id: "s" } }; },
    createTurnStream: async function* () { throw new Error("connection lost"); },
    cancel: async () => { throw new Error("runtime unreachable"); },
  } } as unknown as Parameters<typeof runTurn>[0];
  await assert.rejects(runTurn(client, "primary", "prompt", () => {}, {
    fallbackModel: "secondary",
  }), /Could not confirm TrueForge stopped/);
  assert.equal(attempts, 1);
});

test("already aborted runs create no sessions", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runTurn({} as Parameters<typeof runTurn>[0], "primary", "prompt", () => {}, {
    signal: controller.signal,
  }), /cancelled/);
});

test("duplicate fallback is not retried and unknown terminal states fail", async () => {
  let rolledBack = 0;
  await assert.rejects(runTurn(fakeClient([{ type: "turn.done", state: { status: "unknown" } }]),
    "same", "prompt", () => {}, { fallbackModel: "same", onAttemptFailed: () => { rolledBack++; } }),
    /Unknown TrueForge/);
  assert.equal(rolledBack, 1);
});
