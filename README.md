# FakeFoundy

Early VS Code extension integration proof for TrueFoundry Forge-a-thon.
**Not a complete competition submission.** This repository is built from scratch;
TrueForge is a separately installed runtime, not vendored source.

## Requirements and setup

- Node.js >=22.14; VS Code >=1.96.
- `npm ci`, then `npm test`.
- `HOST=127.0.0.1 npm run trueforge` starts the pinned runtime on port 8790.
  Keep local mode on loopback; never expose it publicly.
- Open http://127.0.0.1:8790 and configure a model provider in TrueForge.
  Keep actual API keys in the runtime's local configuration, never this repository.
- Open this folder in VS Code, press F5 to launch the Extension Development Host.
- Open a small disposable workspace there and set `fakefoundy.model` to the
  configured TrueForge model FQN (for example `openai/gpt-4.1-mini`).
- Run **FakeFoundy: Start TrueForge Agent**. Example: "Read hello.txt and propose
  replacing its contents with a greeting." Events stream to the FakeFoundy output
  channel. The session ID is printed at completion.
- Run **FakeFoundy: Review Proposed Edit** to open a native diff and explicitly
  apply/reject the full-file proposal. Apply edits the buffer using WorkspaceEdit;
  it does not auto-save. Standard editor undo is available.

The bridge binds only 127.0.0.1, authenticates with a random per-process token,
confines paths including symlinks to the first workspace folder, and refuses stale
proposals. A local connector named `fakefoundy-editor` is updated when starting;
use a dedicated local TrueForge instance, because this prototype has one fixed
connector name. Reload the window after changing workspace folders.

## Verification

- `npm test`: TypeScript plus real HTTP MCP round-trip and proposal safety tests.
- With a dedicated TrueForge instance running, `node scripts/smoke.mjs`: real
  TrueForge session/stream/tool loop against a deterministic LOCAL fake model.
  This test creates/replaces a `fakefoundy-smoke` provider and the editor connector.
  It checks read/propose-edit tool execution and verifies unchanged disk content.
  **It is not evidence of real-model reasoning or passing the Flask tasks.**

## Scope and remaining work

Implemented: minimal command UI, SDK sessions and streamed events, authenticated
MCP read/propose-edit bridge, explicit full-file diff review, editor undo path,
workspace confinement and stale-edit checks.

Still required: real-model test; Extension Development Host UI verification;
inline selection/keybinding flow; agent panel; workspace search and terminal MCP
tools; multi-file discovery; budgeted retrieval and @mentions; per-hunk review;
TrueForge approval integration; immediate cancellation; model retry/fallback;
all Flask A/B/C demos; final PDF/video and public submission.

This prototype must not be represented as having passed eligibility or the
competition tasks yet. See `docs/verification.md` for tested scope.

Use Conventional Commits, e.g. `feat(agent): stream TrueForge turns` and
`test(mcp): verify proposal isolation`. Runtime 0.185.1 and SDK 0.185.0 are pinned
independently because those are the available compatible release versions tested.

Sources: https://github.com/truefoundry/trueforge and https://trueforge.dev/api/overview
