# Verification scope

This separates implementation, automated checks, and observed real-model results.
It is not a competition submission or a claim of complete eligibility.

## November 17 Round 1 checks

A clean dependency install and strict TypeScript build succeeded on the local Linux
host, with all 64 project tests passing and none skipped. The earlier results below
are retained for comparison.

**Task A passed in one request** on clean Flask 3.1.3 in Code OSS with
Google Gemini 3.5 Flash-Lite. The user selected `get_debug_flag`, supplied
the official instruction, reviewed the native diff, applied the hunks and saved.
The official `FLASK_DEBUG=off` command printed `False`. Fourteen inputs passed
including missing, empty, false literals, mixed case and truthy controls.
The saved docstring explicitly listed unset, empty, `0`, `false`, `no`, `off`
and `n`. Earlier runs sometimes omitted the empty case from documentation.

On a clean checkout of Flask 3.1.3 at `22d92470`, the exact Task B prompt scanned
212 readable files. Before the change neither the CLI tests nor the CLI guide
appeared in initial context. After matching filename words and distributing the
same 16,000-byte budget across more excerpts, the first three files were
`docs/cli.rst`, `src/flask/cli.py`, and `tests/test_cli.py` (15,929 bytes in
total across all excerpts). This checks discovery only. The unmodified checkout
passed its 58 baseline CLI tests using the tag's locked test dependency group.
With a 96,000-byte recording budget, the same prompt selected those three
files in full plus nine excerpts, using 95,420 UTF-8 bytes.

One exact Gemini 3.5 Flash-Lite run found and proposed the implementation, a
CLI test and documentation. Native review kept all three before the five-minute
deadline expired during the final model call. Timeout correctly cleared the
staged files. Replaying the three original tool results on a separate clean
checkout passed 59 CLI tests and all 491 Flask tests. Help listed the new
command, four sensitive keys were masked, and an ordinary value was preserved.
These replay results establish the generated patch's behavior separately from
editor Apply and completion of that timed-out session.

**Task B passed end to end** in Code OSS on Flask 3.1.3. The exact prompt contained
no file hints. The real Gemini 3.5 Flash-Lite model used TrueForge's deferred
tool discovery and editor reads. It proposed changes to `src/flask/cli.py`,
`tests/test_cli.py` and `docs/cli.rst`, corrected a mismatched documentation
anchor on its own, and requested native review. The same turn finished after all
three proposals were kept. The files stayed clean until hunk Apply and Save.
The saved diff added 72 lines across those three files. It passed all **59 CLI
tests** and **491 Flask tests** with the pinned project dependencies. Running
the real command against a sample app confirmed it appeared in help, emitted
valid JSON, masked all four secret categories, and preserved an ordinary value.
There were no corrective user messages. Earlier rate limits, connection timeouts
and redundant reads make run time variable.

The updated extension passed Task C in Code OSS on a separate X display. With an
unreachable **model provider** configured in a running TrueForge instance, the
official inline instruction produced a visible ECONNREFUSED error. The command
palette opened after the failure, and Flask's Git status stayed clean.

With an automatic fallback configured, a separate exact Task A prompt on a
clean Flask tree reached the unreachable primary model and received ECONNREFUSED.
FakeFoundy selected the separately configured Google-hosted Gemini model itself.
The fallback proposed the selected diff and completed native review. The command
palette remained responsive and Git status was clean before explicit Apply.

A separate editor run used a scripted provider to drive native review. Keep staged
retained a proposal in helpers.py. Rejecting a second batch for cli.py kept only
the earlier helpers.py proposal. Cancelling a third batch at the same gate also
kept only helpers.py. No workspace edits were written. This verifies UI batch
scope and cancellation separately from model reasoning.

## Earlier automated checks

Earlier working-tree check: `npm test` completed **63 tests: 62 passed, one skipped**
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

## Built-in question lifecycle

A clean exact Task B attempt exposed a real integration gap: the runtime emitted
`ask_user_question`, but the editor remained Working without displaying it. That
attempt produced no patches and was cancelled; it is not a Task B success.

The client now resolves `tool.response_required` against the authoritative stored
message, verifies the system tool, and displays its question and bounded choices.
A user answer is posted as `user.tool_response` on the same active turn. Unknown or
malformed requests fail clearly; dismissal and timeout cancel the remote session.

Focused real Gemini/TrueForge VS Code tests passed after the fix: the editor
showed a question with alpha/beta choices, accepting alpha resumed the same turn
and produced the expected reply. Escape cancelled the remote session with zero
answer events. Disk remained unchanged. The question-fix Disco suite passed **60/60**.
These checks verify the question UI, not autonomous completion of Task B.

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
  VS Code. The latest approval smoke below covers Keep staged; it does not establish
  every current-version hunk/rejection/cancellation combination.

The native TrueForge approval protocol has now been verified live for allow, deny
and cancellation. The latest VS Code approval smoke also passed: native diff appeared, **Keep
staged** resumed approval on the same turn, and disk remained unchanged. The
approval toast was behind the progress notification and accessible through the
notifications bell. This verifies the keep-staged UI path, not UI batch rejection
or cancellation. Approval retains proposals; it does not replace later hunk
selection and explicit Apply. No complete integration-score claim is made.

At that revision, a clean autonomous Task B run, native approval UI
reject/cancel paths, and real configured model fallback were still outstanding. Earlier test evidence
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

## Binary snapshot repair

A later Task B attempt exposed binary Flask assets rejected by the text-only
snapshot reader. The sandbox snapshot now copies bounded binary fixtures exactly;
agent-facing read tools remain text-only. Protected paths, symlinks, non-regular
files and oversized files remain excluded or rejected. Descriptor-based path
validation and byte limits apply before copying. A second check compares actual
opened file bytes to each staged proposal's original before overlay, rejecting
edits that arrive after initial validation.

Regression tests cover exact binary bytes, secret/symlink/size rejection, and a
user edit landing between initial validation and copying. These tests passed.
The November 17 Task B run used the pinned Flask virtual environment for the
post-save pytest and CLI verification. Flask dependencies inside the isolated
snapshot remain unverified.

## Known implementation gaps

- Sandbox Python pytest/unittest recipes now exist, but only on non-root Linux
  with functioning bubblewrap namespaces, prlimit, and system Python dependencies.
  No arbitrary shell, host fallback, Flask CLI or dependency installation exists.
- Snapshot limits (500 files, 1 MiB per file, 20 MiB total), read-only mounts, 30-second/256 MiB/no-fork
  bounds and 16 KiB output can prevent valid projects from testing successfully.
- Current native approval UI results are recorded in the November 17 checks above.
- Initial context is budgeted by UTF-8 bytes, not a whole-session token budget;
  references are lexical, not semantic language-server resolution.
- One fixed runtime connector name limits concurrent extension instances.
- Agent reads use disk state rather than pending proposals or unsaved editor
  buffers. Sandbox tests overlay staged patches into their isolated snapshot;
  external tests still require accepted edits to be saved.

No video or submission materials are generated by these checks.
