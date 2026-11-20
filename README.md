# PatchLight

PatchLight is a VS Code extension for making reviewable changes across a codebase. Select a function for an inline edit, or give the agent a feature to implement across files. The editor shows which files it retrieved, streams the agent’s progress, and opens native diffs for approval. You choose which hunks to apply and when to save.

Built from scratch for the TrueFoundry Forge-a-thon at Techfest, IIT Bombay. TrueForge runs locally and owns model execution, sessions, tool calls, and approvals. PatchLight supplies the editor interface and workspace tools.

## Run locally

You need Node.js 22.14 or newer, VS Code or Code OSS 1.96 or newer, and a model configured in TrueForge.

1. Clone the repository and install the pinned dependencies.

   ```sh
   git clone https://github.com/TarunRam-git/FakeFoundy.git
   cd FakeFoundy
   npm ci
   npm run build
   ```

2. Start the dedicated TrueForge runtime from the repository root. This example allows the local editor bridge and the OpenAI API. Substitute the provider hostname if you use another service.

   ```sh
   HOST=127.0.0.1 OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","api.openai.com"]' npm run trueforge
   ```

3. Open the [local TrueForge dashboard](http://127.0.0.1:8790). Add your provider credential and model there. To match the demo, configure OpenAI with model ID `gpt-6-luna` and local model name `luna`. Keep credentials in the runtime. A [Gemini configuration example](examples/gemini-provider.json) illustrates an alternative provider.
4. Open the extension repository in VS Code. Press **F5** and select **Run PatchLight**. In the Extension Development Host, open and trust the project you want the agent to edit.
5. In that window’s settings, set `patchlight.model` to the provider/model name you configured, such as `openai/luna`. The [example editor settings](examples/model-settings.json) match the demo configuration. If your workspace has settings from an earlier release, move their values to the corresponding `patchlight.*` keys and update custom keybindings to the new command IDs.

The runtime and MCP bridge use loopback. Use one active PatchLight workspace per dedicated runtime because the extension updates a shared connector named `patchlight-editor`. The bridge generates a new bearer token for each run.

## Use the extension

| Action | How |
| --- | --- |
| Edit selected code | Save the file, select the region and run **PatchLight: Edit Selection**. The shortcut is **Ctrl+Alt+I** (**Cmd+Alt+I** on macOS). The proposed replacement is restricted to that selection. |
| Request a multi-file change | Run **PatchLight: Open Agent Panel**, enter the task and click **Run**. **PatchLight: Start TrueForge Agent** also accepts a request from the command palette. |
| Inspect and apply | At the TrueForge approval prompt, preview each file and choose **Keep staged** or **Reject batch**. Then use **Review edits**, select the desired hunks, inspect the selected-only diff and choose **Apply**. Save to write the changes to disk. Normal editor Undo works. |
| Interrupt a run | Use the panel’s **Cancel** button or **PatchLight: Cancel Run**. The extension aborts the stream, cancels the remote session and drops proposals created by the interrupted attempt. |
| Answer an agent question | Enter a response in the editor prompt to continue the same turn. Escape cancels the run. Answers stay out of the panel and output log. |

During final hunk review, Escape keeps the pending proposal. Applying selected hunks discards the unselected ones. PatchLight checks both the disk file and editor buffer against the original before applying.

## How it works

- **Context selection.** Filename and content matches rank candidate files. Explicit references such as `@file:src/app.py`, `@file:"some directory/app.py"` and `@symbol:load_config` get priority. Matching is lexical. The panel shows selected paths, reasons and UTF-8 bytes used. If the top three files together fit within 85% of the budget, the extension includes them in full. Otherwise it selects excerpts. Inline mode sends the selection, with additional retrieval for explicit references. [Context selection](src/context.ts)
- **TrueForge integration.** The extension submits the agent definition when creating a session, selectively preloads tool schemas and streams turn events. The MCP bridge exposes search, bounded reads, staged patches and approved terminal operations. TrueForge pauses for editor approval on `review_staged_edits`. The panel displays the session ID for inspection in the dashboard. [Agent definition](agents/README.md) · [Client](src/client.ts) · [Editor tools](src/bridge.ts)
- **Staged edits.** Small patches anchor to unique original text. Disjoint changes can be combined and staged patches can be revised before approval. File reads use saved disk content. Proposed edits stay in memory until review. [Proposal store](src/proposals.ts) · [Hunk selection](src/hunks.ts)
- **Failure handling.** TrueForge retries eligible provider requests with bounded backoff. An optional second configured model can take over once after an unsuccessful primary run. PatchLight drops failed-attempt proposals first and requires confirmation of remote cancellation when an attempt might still be running. [Retry behavior](docs/runtime-retries.md)

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `patchlight.model` | `openai/gpt-4.1-mini` | Provider/model name registered in your local runtime |
| `patchlight.baseUrl` | `http://127.0.0.1:8790` | Local TrueForge HTTP endpoint |
| `patchlight.mcpPort` | `31337` | Local editor bridge port |
| `patchlight.contextBudgetBytes` | `16000` | Initial retrieved context, configurable from 256 to 131072 UTF-8 bytes. Prompt and later tool results are additional. |
| `patchlight.runTimeoutSeconds` | `300` | Deadline for the complete run including fallback, from 10 to 1800 seconds |
| `patchlight.fallbackModel` | empty | Optional second provider/model configured in TrueForge |

## Testing and limits

Run `npm test` to build the TypeScript extension and run its automated suites. To exercise the actual runtime and MCP approval protocol, start a separate local TrueForge instance with loopback access, then run `npm run smoke`. Set `TRUEFORGE_URL` for a different runtime port. The smoke test uses a deterministic local model stub.

The agent terminal supports guarded read-only commands and approved `python3 -m pytest` or `python3 -m unittest` recipes. On a compatible non-root Linux host, review can request up to three new pytest tests against a filtered, read-only snapshot containing staged edits. This requires bubblewrap, prlimit, system Python and permitted user/network namespaces. The snapshot has no network or access to the host home directory. Only system Python packages are available. Limits include 500 files, 1 MiB per file, 20 MiB total, 30 seconds, 256 MiB of address space and 16 KiB of combined output. To run the full project suite with a project virtual environment, apply and save the changes, then use the editor’s integrated terminal.

## Round 1 demo

The demonstration uses `pallets/flask` at tag `3.1.3` (commit `22d92470`).

1. **Inline edit.** Select `get_debug_flag`, request support for two additional false values and review the diff. Verify `FLASK_DEBUG=off` prints `False`.
2. **Agent mode.** Request a built-in `flask config` command without naming files. Inspect the source, test and documentation changes. Run `pytest tests/test_cli.py -q`, check Flask help, and display masked JSON from a sample app. Inspect the matching TrueForge session.
3. **Provider failure.** Repeat the inline request with an unreachable model endpoint. Check the editor error and confirm a clean working tree.

## License and dependencies

PatchLight is [MIT licensed](LICENSE). The project uses the [TrueForge runtime and SDK](https://github.com/truefoundry/trueforge), the Model Context Protocol SDK and [jsdiff](https://github.com/kpdecker/jsdiff) for line differencing. Dependency versions are pinned in the lockfile.
