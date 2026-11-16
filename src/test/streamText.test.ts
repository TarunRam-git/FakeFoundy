import { test } from "node:test";
import assert from "node:assert/strict";
import { streamText, StreamFormatter } from "../streamText.js";
test("stream displays public text and tool names, not reasoning or raw results", () => {
  assert.equal(streamText({ type: "model.message.delta", content: "Hello", reasoningContent: "private reasoning" }), "Hello");
  assert.equal(streamText({ type: "model.message.delta", reasoningContent: "private reasoning" }), "");
  assert.equal(streamText({ type: "model.message", content: "Already streamed", toolCalls: [{ function: { name: "read_file", arguments: "private args" } }] }), "\nTools: read_file\n");
  assert.equal(streamText({ type: "tool.response", content: "private file text" }), "\nTool completed.\n");
  assert.equal(streamText(null), "");
});

test("formatter shows final-only content and deduplicates deltas per thread/message", () => {
  const f = new StreamFormatter();
  assert.equal(f.format({type:"model.message.delta", threadId:"a", content:"Hello"}), "Hello");
  assert.equal(f.format({type:"model.message", threadId:"b", content:"Other"}), "Other");
  assert.equal(f.format({type:"model.message", threadId:"a", content:"Hello"}), "");
  assert.equal(f.format({type:"model.message", threadId:"a", content:[{type:"text",text:"Next"}]}), "Next");
  assert.equal(f.format({type:"model.message", reasoningContent:"private"}), "");
});
