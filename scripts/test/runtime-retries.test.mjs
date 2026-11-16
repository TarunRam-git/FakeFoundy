import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { runtimeEnvironment } from "../trueforge.mjs";
import { createOutboundFetch, configureOutboundUrlGuard, defaultModelOutboundFetchOptions } from "@truefoundry/trueforge-core/core";

test("runtime launcher bounds retry count without changing other runtime/security settings", () => {
  const env = { HOST: "127.0.0.1", NETWORK_POLICY_ENABLED: "true", EXAMPLE: "keep" };
  assert.deepEqual(runtimeEnvironment(env), { ...env, MODEL_HTTP_MAX_RETRIES: "7" });
  assert.equal(runtimeEnvironment({ MODEL_HTTP_MAX_RETRIES: "0" }).MODEL_HTTP_MAX_RETRIES, "0");
  assert.equal(runtimeEnvironment({ MODEL_HTTP_MAX_RETRIES: "8" }).MODEL_HTTP_MAX_RETRIES, "8");
  for (const value of ["9", "-1", "1.5", "Infinity", "", "3;echo nope"])
    assert.throws(() => runtimeEnvironment({ MODEL_HTTP_MAX_RETRIES: value }), /0 to 8/);
  assert.equal(env.MODEL_HTTP_MAX_RETRIES, undefined);
});

// Tests the actual pinned TrueForge HTTP retry layer using only loopback.
// Guard remains enabled, with a test-process-only exact loopback allowlist.
test("native retry replays only rate-limited model HTTP, preserves body and aborts backoff", async () => {
  configureOutboundUrlGuard({ enabled: true, allowedHosts: ["127.0.0.1"], blockedHosts: [] });
  const bodies = [];
  let mode = "recover";
  let notify429;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    bodies.push(body);
    if (mode === "deny") { res.writeHead(401); res.end("unauthorized"); return; }
    if (mode === "cancel" || bodies.length === 1) {
      res.writeHead(429, { "retry-after-ms": mode === "cancel" ? "4000" : "1" });
      res.end("rate limited"); notify429?.(); return;
    }
    res.writeHead(200); res.end("ok");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const transport = createOutboundFetch({ ...defaultModelOutboundFetchOptions(), maxRetries: 7 });
  const url = `http://127.0.0.1:${server.address().port}/model`;
  try {
    const body = JSON.stringify({ messages: [{ role: "user", content: "local test only" }] });
    const recovered = await transport.fetch(url, { method: "POST", body });
    assert.equal(await recovered.text(), "ok");
    assert.deepEqual(bodies, [body, body]);
    mode = "deny";
    const denied = await transport.fetch(url, { method: "POST", body });
    assert.equal(denied.status, 401); await denied.text();
    assert.equal(bodies.length, 3, "authentication errors are not retried");
    mode = "cancel";
    const controller = new AbortController();
    const received = new Promise(resolve => { notify429 = resolve; });
    const pending = transport.fetch(url, { method: "POST", body, signal: controller.signal });
    await received;
    const start = Date.now(); controller.abort();
    await assert.rejects(pending, /abort/i);
    assert.ok(Date.now() - start < 1000, "cancel interrupts four-second backoff");
    assert.equal(bodies.length, 4, "no model request after cancellation");
  } finally {
    await transport.close();
    await new Promise(resolve => server.close(resolve));
  }
});
