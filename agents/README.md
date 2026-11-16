# Agent definition

`src/client.ts` exports the authoritative `instructions` and assembles the inline
TrueForge agent spec passed to `sessions.create`. The model is selected using
`fakefoundy.model`; tools attach by connector name `fakefoundy-editor`.

The two initial tools only read and stage proposals, so they do not require
harness approval. Editor review is the only apply path. This is NOT the final
competition approval design: TrueForge approval-driven hunk review is still TODO.
No direct model calls exist in the extension.
