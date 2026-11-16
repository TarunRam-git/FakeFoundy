# FakeFoundy

A VS Code coding-agent extension for the TrueFoundry Forge-a-thon, built from
scratch. TrueForge owns model execution and the agent/tool loop; the extension
provides workspace tools, bounded context, streaming UI, and explicit diff review.
TrueForge is a separately installed dependency, not vendored source.

**Working implementation, not yet a fully verified competition submission.**
Real Flask Task A checks and failure-path Task C have passed. Task A needed a
follow-up doc correction, and Task B needed assisted corrections, so neither is
recorded as a pristine one-request pass.
See [verification scope](docs/verification.md).

## Local setup

1. Install Node.js >=22.14 and VS Code >=1.96.
2. In this repository run `npm ci`, then `npm test`.
3. Start a dedicated local runtime: `HOST=127.0.0.1 npm run trueforge`.
   Runtime 0.185.1 and SDK 0.185.0 are pinned. The launcher enables bounded native
   provider retries; see [retry behavior](docs/runtime-retries.md).
4. Open http://127.0.0.1:8790 and configure a provider/model in TrueForge. Keep
   credentials in the runtime configuration, never in this repository or prompts.
5. Open this repository in VS Code and press F5 using **Run FakeFoundy**. In the
   Extension Development Host, open and trust a disposable workspace.
6. Set `fakefoundy.model` to the exact configured TrueForge model FQN. The default
   `openai/gpt-4.1-mini` is only a placeholder unless configured in your runtime.
   `fakefoundy.baseUrl` defaults to `http://127.0.0.1:8790`.

Keep both runtime and bridge on loopback. The bridge defaults to port 31337 and
uses a random bearer capability. A runtime outbound-host policy may refuse its
loopback MCP connection (and the smoke fixture's loopback model). Diagnose this
in the dedicated runtime; the launcher does not change network/security policy
or enable access exceptions. Do not expose the runtime publicly as a workaround.

Use a dedicated runtime and one active extension workspace: the connector name
`fakefoundy-editor` is shared, and each extension run updates that connector.

## Use

- **FakeFoundy: Open Agent Panel** opens the task input, streamed response,
  context selection summary, Cancel button, and Review edits button.
- **FakeFoundy: Start TrueForge Agent** accepts a task through the command palette.
- Select code and press **Ctrl+Alt+I** (**Cmd+Alt+I** on macOS), or run
  **FakeFoundy: Edit Selection**. Give an instruction; the resulting proposal is
  restricted to that captured selection and opens the review flow after success.
- Reference a file with `@file:src/example.py`, a spaced path with
  `@file:"some directory/example.py"`, or an identifier with `@symbol:example`.
  Symbol matching is lexical, not language-server navigation.
- During a run, TrueForge pauses at `review_staged_edits`. The extension previews
  the batch and asks whether to keep it staged or reject it. This does not apply
  edits. The live protocol has been checked; the new VS Code approval gate still
  needs end-to-end UI verification.
- **FakeFoundy: Review Proposed Edit** opens a native diff. Choose the hunks to
  accept, inspect the selected-only diff, then Apply or Reject. Unselected hunks
  are discarded after confirmation. Escape preserves the proposal.
- Apply changes the editor buffer, not the file on disk. Save accepted changes
  before running external tests. Normal editor Undo is available. Changes to the
  file/buffer since proposal creation cause review to fail safely.
- **FakeFoundy: Cancel Run** or the progress/panel Cancel button aborts the request,
  cancels its remote session, and discards proposals from that failed attempt.
  Earlier pending proposals are preserved. No agent tool applies edits directly.

Context retrieval automatically ranks bounded excerpts using path/text relevance
and explicit references. The panel shows chosen paths, reasons, and byte usage.
`fakefoundy.contextBudgetBytes` defaults to 16000 (256–65536). This bounds initial
retrieved excerpts, **not** the user prompt or all subsequent tool output. File
reads are paginated; discovery/search exclude protected and generated paths.

Optional settings: `fakefoundy.fallbackModel` selects one separately configured
fallback; failed-attempt proposals are discarded before it runs.
`fakefoundy.runTimeoutSeconds` defaults to 300 and covers the whole run, including
fallback. Unconfirmed remote cancellation stops fallback rather than starting
another potentially concurrent attempt.

## Tools and limitations

The MCP bridge supports discovery, search, bounded file reads, selection
replacement, and composing small disjoint patches against original disk text.
Full-file model replacement is disabled. Proposed text remains staged until
editor approval. Reads do not include pending patches or unsaved editor edits;
save accepted edits before starting a dependent task.

The terminal tool retains guarded read-only `pwd`, `ls`, and `cat` recipes. It also
supports fixed `python3 -m pytest` / `python3 -m unittest` recipes with bounded
arguments and explicit one-time approval. Executable recipes require non-root
Linux with `/usr/bin/bwrap`, `/usr/bin/prlimit`, `/usr/bin/python3` and permitted
user/network namespaces. There is **no unsandboxed fallback**.

Tests run in a temporary filtered text snapshot including staged patches, not the
real workspace. The snapshot is read-only inside the sandbox; network, host home,
credentials and dependency installation are unavailable. Only system Python
packages are visible, not project virtualenvs. Bounds: 500 files, 20 MiB snapshot,
30 seconds, 256 MiB address space, no subprocess creation and 16 KiB combined
output. These restrictions can reject otherwise valid suites. Save/apply is not
required for snapshot tests, but remains required for external tests. General
shells, arbitrary Python commands, Flask CLI execution and builds are unsupported.

Native TrueForge approval now gates keeping a staged batch; per-hunk selection
and editor Apply are a separate later step. Do not equate the protocol check with
verified end-to-end approval UI or complete competition scoring compliance.
Outstanding validation includes autonomous fixed-task B, the new approval UI,
and real configured fallback behavior. See verification scope for exact evidence.

## Tests

`npm test` compiles TypeScript and runs unit/transport tests, including real HTTP
MCP calls, bounded patch composition, confinement, retry semantics, and rollback.
The latest local run: 54 tests, 53 passed, one host-dependent isolation test
skipped because this host denied sandbox network-namespace setup. This is not a
real-model benchmark, and a skipped isolation test is not a security pass.

`npm run smoke` uses a separately running dedicated TrueForge instance and a
**deterministic local fake model** to test transport wiring. It creates/replaces
the `fakefoundy-smoke` provider and editor connector. It requires permitted local
runtime connections and does not prove real-model reasoning or Flask success.

Use Conventional Commits and preserve the MIT license. Agent definition:
[agents/README.md](agents/README.md). Upstream references:
[TrueForge](https://github.com/truefoundry/trueforge),
[API overview](https://trueforge.dev/api/overview).
