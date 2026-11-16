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

## Blocked, not passed

- Full TrueForge session → model → MCP tools → streamed result smoke:
  the stock runtime rejects the loopback model provider URL with HTTP 400,
  `Outbound URL blocked for host "127.0.0.1"`.
- The supported runtime `OUTBOUND_URL_ALLOWED_HOSTS` setting can allow this
  specific host, but it is a security-sensitive exception. It is not enabled by
  our scripts or defaults. Approval is required before applying it here.
- No paid/external model has been configured or called.

## Not run / not implemented

- VS Code Extension Development Host visual validation has not been performed.
- Full-file review UI is compiled but not visually verified.
- Flask Tasks A/B/C are not yet implemented or demonstrated.
- This is a stage-1 prototype, not a ready Round 1 submission.
