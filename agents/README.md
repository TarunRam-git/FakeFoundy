# Agent definition

`src/client.ts` exports the authoritative `instructions` and assembles the inline
TrueForge agent spec passed to `sessions.create`. The configured TrueForge model
is selected using `fakefoundy.model`; optional `fakefoundy.fallbackModel` is tried
once after failure cleanup. No direct provider calls exist in the extension.

Tools attach through the dedicated `fakefoundy-editor` MCP connector. They cover
workspace discovery/search, bounded reads, staged selection replacements and
composable bounded patches. Full-file model replacements are disabled. Reads
reflect original disk text, not pending proposals. The terminal tool supports explicitly approved read-only recipes and bounded
Python pytest/unittest execution in a required Linux bubblewrap sandbox. It cannot
run a general shell or builds; unsupported hosts fail closed.

The instructions encourage targeted discovery, reuse of supplied context,
minimal patches, and honest reporting of pending edits or blockers. Initial
context is selected by `src/context.ts` and its budget/reasons shown in the panel.

`requireApprovalForTools` includes `review_staged_edits`. The agent must request
this after staging its batch. The client handles native approval on the same turn;
the extension previews proposals and asks to keep staged or reject the batch.
Successful native approval is not editor Apply: independent hunk selection and
explicit buffer application happen afterwards. A run that leaves unapproved
changes fails closed. Live allow/deny/cancel protocol checks passed. The VS Code native-diff and
Keep staged path also passed, with same-turn approval and unchanged disk.
That UI result does not verify every rejection/cancellation path.
