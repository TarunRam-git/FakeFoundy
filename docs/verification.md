# Verification scope

## Passed

- `npm test`: strict TypeScript compilation; five Node test cases.
- Real Streamable HTTP MCP initialization, tools/list and tools/call.
- Proposal tool stages an edit without changing disk.
- Missing bridge bearer token returns 401.
- Rejection removes proposal; stale-file apply is rejected.
- Error/cancelled/truncated TrueForge event streams are not reported as success.
- Sensitive credential paths (including symlink aliases) and oversized files are refused.
- Absolute outside paths and symlinks escaping workspace are rejected.
- TrueForge 0.185.1 launches in local SQLite mode with data under a temporary directory.

## End-to-end runtime smoke: passed

After explicit approval, a dedicated temporary TrueForge process was started
with only `127.0.0.1` added to its outbound-host allowlist. No persistent runtime
or system configuration was changed. Runtime was stopped after the test; connection
to port 8792 was verified refused afterwards.

- Real TrueForge 0.185.1 session created successfully.
- 16 streamed events: turn.created, mcp.initialize, model.message,
  model.message.delta, tool.response, turn.done.
- Three model requests against a deterministic local fake OpenAI-compatible model.
- MCP read_file followed by propose_edit; one proposal staged.
- Workspace file remained unchanged.
- Terminal turn status was successful.

This proves real harness → local MCP → staged-edit transport wiring. It does NOT
prove real-model reasoning, VS Code UI behavior, or competition task success.
The stock runtime still blocks loopback connector/provider URLs; approval was
limited to this test process, and no exception is enabled by repository defaults.
No paid/external model was configured or called.

## Not run / not implemented

- VS Code Extension Development Host visual validation has not been performed.
- Full-file review UI is compiled but not visually verified.
- Flask Tasks A/B/C are not yet implemented or demonstrated.
- This is a stage-1 prototype, not a ready Round 1 submission.
