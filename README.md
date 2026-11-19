# FakeFoundy

A VS Code coding-agent extension for the TrueFoundry Forge-a-thon, built from
scratch. TrueForge owns model execution and the agent/tool loop; the extension
provides workspace tools, bounded context, streaming UI, and explicit diff review.
TrueForge is a separately installed dependency, not vendored source.

## Local setup

1. Install Node.js >=22.14 and VS Code >=1.96.
2. In this repository run `npm ci`, then `npm run build`.
3. Start the dedicated local runtime with its local editor connector enabled:
   `HOST=127.0.0.1 OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","generativelanguage.googleapis.com"]' npm run trueforge`.
   This process permits its tools to reach services on IPv4 loopback. Use it only
   for your trusted local workspace. The example allows the Google Gemini API;
   use your configured provider hostname when switching providers.
   Runtime 0.185.1 and SDK 0.185.0 are pinned. The launcher enables bounded native
   provider retries; see [retry behavior](docs/runtime-retries.md).
4. Open http://127.0.0.1:8790 and configure a provider/model in TrueForge. Keep
   credentials in the runtime configuration, never in this repository or prompts.
   [Gemini provider example](examples/gemini-provider.json) shows the local HTTP API fields.
   Use the dashboard to enter the real values.
5. Open this repository in VS Code and press F5 using **Run FakeFoundy**. In the
   Extension Development Host, open and trust a disposable workspace.
6. Enter the values from [the example VS Code model settings](examples/model-settings.json)
   in the Development Host's user settings. The example uses 96000 initial
   context bytes and a ten-minute deadline for provider backoff.
   For the example, configure the Google
   Gemini provider in TrueForge, enter your API key there, and name a model
   `demo` with the upstream model ID available to your account. If your provider
   or model has another name, set `fakefoundy.model` to its exact TrueForge FQN.
   On each run the extension sends the agent definition in `src/client.ts` when
   creating the session. The default
   `openai/gpt-4.1-mini` is only a placeholder unless configured in your runtime.
   `fakefoundy.baseUrl` defaults to `http://127.0.0.1:8790`.

Keep both runtime and bridge on loopback. The bridge defaults to port 31337 and
uses a fresh random bearer capability per run. The runtime must be able to reach
this bridge. The setup command grants the loopback exception for that runtime process only.

Use a dedicated runtime and one active extension workspace: the connector name
`fakefoundy-editor` is shared, and each extension run updates that connector.

## Use

- **FakeFoundy: Open Agent Panel** opens the task input, streamed response,
  context selection summary, Cancel button, and Review edits button.
- **FakeFoundy: Start TrueForge Agent** accepts a task through the command palette.
- Select code and press **Ctrl+Alt+I** (**Cmd+Alt+I** on macOS), or run
  **FakeFoundy: Edit Selection**. Give an instruction; the resulting proposal is
  restricted to that captured selection and opens the review flow after success.
  Save the source file before requesting an inline edit.
- Reference a file with `@file:src/example.py`, a spaced path with
  `@file:"some directory/example.py"`, or an identifier with `@symbol:example`.
  Symbol matching is lexical, not language-server navigation.
- During a run, TrueForge pauses at `review_staged_edits`. The extension previews
  each staged file in a native diff with a **Keep staged** or **Reject batch**
  picker. On Linux, review can request approval to run up to three newly added
  pytest tests in the isolated snapshot and return their results to the agent.
  If the model ends a turn with unreviewed proposals, the extension
  requests review once in the same session. Approval keeps proposals available
  for hunk review. The panel shows the TrueForge session ID.
- **FakeFoundy: Review Proposed Edit** opens a native diff. Choose the hunks to
  accept, inspect the selected-only diff, then Apply or Reject. Unselected hunks
  are discarded after confirmation. Escape preserves the proposal.
- Apply changes the editor buffer, not the file on disk. Save accepted changes
  before running external tests. Normal editor Undo is available. Changes to the
  file/buffer since proposal creation cause review to fail safely.
- Built-in agent questions appear in the panel and an editor input box, including
  any supplied choices. Enter an answer to continue the same turn; Escape cancels
  the run. Unknown or malformed client-side tools fail clearly rather than leaving
  the editor waiting. Answers are not copied into the panel or output log.
- **FakeFoundy: Cancel Run** or the progress/panel Cancel button aborts the request,
  cancels its remote session, and discards proposals from that failed attempt.
  Earlier pending proposals are preserved. No agent tool applies edits directly.

The panel shows which files retrieval selected, why it chose them, and how many
UTF-8 bytes they used. The initial scan prioritizes filenames that match the
request before ranking file contents. `fakefoundy.contextBudgetBytes` defaults
to 16000 (256–131072). If the top three files fit within 85% of that budget, they
are included in full. Inline requests include the exact selection and retrieve
additional workspace context when the user includes an explicit reference.
This budget covers the initial repository context. File
reads are paginated; the related-file reader returns outlines and targeted excerpts
for up to three files in one call below TrueForge’s response limit. Discovery/search exclude protected and generated paths.

Optional settings: `fakefoundy.fallbackModel` selects one separately configured
fallback; failed-attempt proposals are discarded before it runs.
`fakefoundy.runTimeoutSeconds` defaults to 300 and covers the whole run, including
fallback. Unconfirmed remote cancellation stops fallback rather than starting
another potentially concurrent attempt.

## Tools and limitations

The MCP bridge supports discovery, search, bounded file reads, selection
replacement, and composing small disjoint patches against original disk text.
The agent can explicitly revise a staged patch by reusing its exact original
range or targeting a unique snippet inside its staged text. The revised result
goes through review.
Full-file model replacement is disabled. Proposed text remains staged until
editor approval. Reads do not include pending patches or unsaved editor edits;
save accepted edits before starting a dependent task.

The terminal tool retains guarded read-only `pwd`, `ls`, and `cat` recipes. It also
supports fixed `python3 -m pytest` / `python3 -m unittest` recipes with bounded
arguments and explicit one-time approval. Executable recipes require non-root
Linux with `/usr/bin/bwrap`, `/usr/bin/prlimit`, `/usr/bin/python3` and permitted
user/network namespaces. There is **no unsandboxed fallback**.

Tests run in a temporary filtered file snapshot including staged text patches, not the
real workspace. Bounded binary fixtures are copied byte-for-byte, but model-facing
read tools remain text-only. Staged files are revalidated against the actual opened
bytes before overlay. The snapshot is read-only inside the sandbox; network, host home,
credentials and dependency installation are unavailable. Only system Python
packages are visible, not project virtualenvs. Bounds: 500 files, 1 MiB per file, 20 MiB snapshot,
30 seconds, 256 MiB address space, no subprocess creation and 16 KiB combined
output. These restrictions can reject otherwise valid suites. Save/apply is not
required for snapshot tests, but remains required for external tests. General
shells, arbitrary Python commands, Flask CLI execution and builds are unsupported.

Use Conventional Commits and preserve the MIT license. Agent definition:
[agents/README.md](agents/README.md). Upstream references:
[TrueForge](https://github.com/truefoundry/trueforge),
[API overview](https://trueforge.dev/api/overview), and
[jsdiff](https://github.com/kpdecker/jsdiff) (BSD-3-Clause) for line differencing.

`npm test` and `npm run smoke` require the Git-ignored local validation files.
