# Verification scope

This separates implementation, automated checks, and observed real-model results.
It is not a competition submission or a claim of complete eligibility.

## Current automated checks

Latest working-tree check: `npm test` completed **54 tests: 53 passed, one skipped**
after strict TypeScript compilation. The skipped test needs functioning sandbox
namespaces; this host denied `NETLINK_ROUTE` setup. A skip does not verify isolation.
The earlier committed baseline `966699c` passed 38/38. Tests cover:

- Real Streamable HTTP MCP initialization, tool listing/calls and bearer rejection.
- Discovery/search boundaries, Git ignore behavior, protected-file and symlink confinement.
- Bounded line reads, Unicode pagination and explicit EOF behavior.
- Selection-only edits, small patch limits, exact anchors, disjoint same-file
  composition, stale/ambiguous/concurrent request rejection.
- No disk changes when staging, cancellation/generation isolation, independent hunks.
- Explicit references and bounded automatic context with selection reasons.
- Terminal allowlist, explicit approval, immutable approved arguments, bounded output.
- Stream presentation and deduplication without exposing raw reasoning/results.
- Terminal-state checking, failed-attempt rollback callbacks, optional-model fallback,
  remote cancellation and refusal to fall back when stopping is unconfirmed.
- Native provider retry transport: 429 recovery, non-retried 401 and cancellation
  during backoff. These tests use a local fixture, not paid provider quota.

Unit tests do not execute the complete VS Code review UI and do not establish
real-model success on the fixed competition tasks.

Additional checks cover native approval allow/deny on the same turn, unknown or
duplicate requests, approval-time cancellation, pending-action handling, sandbox
recipe admission, process bounds, and snapshot confinement/stale-proposal checks.

## Real-model and editor observations

The fixed target is `pallets/flask`, tag `3.1.3`, commit prefix `22d92470`.

- **Task A: verified after follow-up correction**, not a pristine one-request
  pass. Real Gemini produced the off/n behavior; a further product-mediated
  correction fixed the docstring. Native review rejected a body-deletion hunk and
  accepted the doc-only change. Unset/empty/0/false/no/off/n and mixed-case variants
  returned false; 1/true returned true. Undo/redo were verified.
- **Task B: assisted, not autonomous.** The initial no-file-hints request found
  three files, but required corrective assistance through the product. The final
  reviewed result changed three files (69 additions, no deletions), passed 59 CLI
  tests and 491 full-suite tests, appeared in help, and produced masked JSON with
  a real app. This validates the repaired result, not an exact one-request pass.
- **Task C: passed** on earlier `f073a9a` source: unreachable endpoint produced a
  clear ECONNREFUSED error, responsive editor, and clean Git status. This is not
  proof of real-model automatic fallback success.
- Generation cancellation was observed with approximately 171 ms to UI Ready and
  a remotely cancelled session. This evidence predates the newest approval gate.
- Native diff, selective rejection/acceptance and Undo/redo were exercised in real
  VS Code. Repeat these through the new approval gate before claiming the complete
  current-version flow has passed.

The native TrueForge approval protocol has now been verified live for allow, deny
and cancellation. The new VS Code
callback that previews a batch and returns keep/reject **has not yet been verified
end to end**. Approval retains proposals; it does not replace later hunk selection
and explicit Apply. No full integration scoring claim follows from protocol alone.

Still required: a clean autonomous Task B run, the latest native approval UI
allow/reject/cancel path, and real configured model fallback. Earlier test evidence
must not silently be attributed to the newest working-tree changes.

## Runtime transport smoke

An earlier dedicated TrueForge 0.185.1 loopback run successfully created a session,
streamed events and executed MCP reads/proposals against a deterministic fake
OpenAI-compatible model while preserving disk content. That established transport
wiring, not real-model reasoning. The current smoke script uses bounded patches.

Local runtime connection policy must permit the dedicated loopback bridge and
fixture provider. Earlier testing used a temporary process-scoped exception;
repository defaults do not enable that exception or change system security.

## Isolated test execution

Strict sandbox verification on Disco passed **8/8** tests, unlike the cloud host
where the isolation test was skipped. This verifies the tested isolation behavior
on that host; it is not evidence that every project or Flask suite runs inside
the sandbox. Host capability checks remain mandatory and unsupported hosts fail
closed. The earlier Flask 59/491-test results must not be described as runs of
this new terminal integration.

## Known implementation gaps

- Sandbox Python pytest/unittest recipes now exist, but only on non-root Linux
  with functioning bubblewrap namespaces, prlimit, and system Python dependencies.
  No arbitrary shell, host fallback, Flask CLI or dependency installation exists.
- Snapshot limits (500 text files/20 MiB), read-only mounts, 30-second/256 MiB/no-fork
  bounds and 16 KiB output can prevent valid projects from testing successfully.
- Native batch approval is implemented; its new VS Code UI path remains unverified.
- Initial context is budgeted by UTF-8 bytes, not a whole-session token budget;
  references are lexical, not semantic language-server resolution.
- One fixed runtime connector name limits concurrent extension instances.
- Agent reads use disk state rather than pending proposals or unsaved editor
  buffers. Sandbox tests overlay staged patches into their isolated snapshot;
  external tests still require accepted edits to be saved.

No video or submission materials are generated by these checks.
