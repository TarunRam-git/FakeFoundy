# Agent definition

`src/client.ts` exports the authoritative `instructions` and assembles the inline
TrueForge agent spec passed to `sessions.create`. The configured TrueForge model
is selected using `patchlight.model`; optional `patchlight.fallbackModel` is tried
once after failure cleanup. No direct provider calls exist in the extension.

Tools attach through the dedicated `patchlight-editor` MCP connector. They cover
workspace discovery/search, bounded reads, staged selection replacements and
composable bounded patches. Full-file model replacements are disabled. Reads
reflect original disk text, not pending proposals. The terminal tool supports explicitly approved read-only recipes and bounded
Python pytest/unittest execution in a required Linux bubblewrap sandbox. It cannot
run a general shell or builds; unsupported hosts fail closed.

TrueForge preloads the related-file reader, selection replacement, patch and
review tools. It defers discovery, search, pagination and terminal schemas until
the model needs them. Keeping the review operation directly attached preserves
its MCP identity when the harness asks for approval. For a deferred call, the client verifies the stored system tool, exact server, review operation and empty arguments before showing approval. The legacy whole-file read
and disabled replacement are excluded. Related-file reads return outlines and
targeted excerpts below the harness response limit.

The instructions encourage targeted discovery, reuse of supplied context,
minimal patches, and honest reporting of pending edits or blockers. Initial
context is selected by `src/context.ts` and its budget/reasons shown in the panel.

`requireApprovalForTools` includes `review_staged_edits`. The agent must request
this after staging its batch. The client handles native approval on the same turn;
the extension previews proposals and asks to keep staged or reject the batch.
Native approval keeps changes staged for independent hunk selection and explicit
buffer application. If the model ends a turn without requesting review, the
extension sends one review reminder in the same session. An unapproved batch
remaining after that reminder is discarded.

Built-in `ask_user_question` requests are handled through verified persisted tool
identity and same-turn `user.tool_response` events. The editor shows the question
and choices; Escape or cancellation stops the run. Missing, unsupported or
malformed question requests fail clearly rather than being silently ignored.
