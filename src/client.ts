type TrueForgeClient = InstanceType<
  typeof import("@truefoundry/trueforge-sdk", {
    with: { "resolution-mode": "import" }
  }).TrueForge
>;
export const instructions = [
  "You are FakeFoundy, a workspace coding assistant. Use only the editor MCP tools for workspace work, never call model providers directly.",
  "Plan briefly, discover likely files once, then search only unresolved symbols or anchors. Use the supplied workspace context first. Read relevant ranges with fakefoundy_read_file, the authoritative editor reader, not generic read_file or cat. Follow pagination only when needed; cache unchanged excerpts and do not reread or repeat searches already answered.",
  "After locating the affected implementation, tests and documentation, stage the smallest justified patches promptly. Do not explore unrelated files or keep searching after enough evidence exists. After eight read/search calls, assess what is missing: either stage the supported changes or name the precise blocker before making further targeted reads. Never claim completion when edits are missing.",
  "Use propose_patch for bounded, disjoint changes against ORIGINAL disk text; same-file patches compose. Read tools still show original content, not staged replacements. Preserve unrelated code and tests. Full-file propose_edit is disabled. For inline tasks use propose_selection with replacement text only.",
  "Tool JSON text fields are strings: use actual newline characters in old_text/new_text, encoded once for JSON transport. Never double-escape newlines into literal backslash-n characters. Copy a short unique original anchor exactly, including indentation. When a patch errors, follow its specific guidance and correct the argument; do not restart discovery or repeat an unchanged failing call. Stop and explain an unresolved blocker after two corrected failures.",
  "All proposals require editor review; never claim pending edits were applied. Summarize staged files and remaining caveats when finished.",
].join(" ");
export async function createClient(baseUrl: string) {
  const url = new URL(baseUrl);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.protocol !== "http:"
  )
    throw new Error("This prototype supports local HTTP TrueForge only");
  const { TrueForge } = await import("@truefoundry/trueforge-sdk");
  return new TrueForge({ baseUrl, maxRetries: 0 });
}
export class RunCancelledError extends Error {
  constructor(message = "TrueForge turn cancelled") { super(message); this.name = "RunCancelledError"; }
}
export interface RunOptions {
  signal?: AbortSignal;
  /** A separately configured model; never silently replace the user's model. */
  fallbackModel?: string;
  /** Called after a failed attempt, before any fallback can stage new edits. */
  onAttemptStart?: () => void;
  onAttemptFailed?: () => void | Promise<void>;
  onFallback?: (model: string) => void;
}
export async function runTurn(
  client: TrueForgeClient,
  model: string,
  prompt: string,
  onEvent: (event: unknown) => void,
  options: RunOptions = {},
) {
  if (!model.trim()) throw new Error("Configure a non-empty FakeFoundy model first");
  const models = [model.trim()];
  const fallback = options.fallbackModel?.trim();
  if (fallback && fallback !== models[0]) models.push(fallback);
  for (let attempt = 0; attempt < models.length; attempt++) {
    let sessionId: string | undefined;
    let terminal = false;
    let cleanupConfirmed = true;
    try {
      if (options.signal?.aborted) throw new RunCancelledError();
      options.onAttemptStart?.();
      const requestOptions = { abortSignal: options.signal, maxRetries: 0 };
      const session = await client.sessions.create({
        agent: { spec: {
          instructions,
          model: { name: models[attempt] },
          mcpServers: [{ name: "fakefoundy-editor", preload: true, requireApprovalForTools: [] }],
        } },
      }, requestOptions);
      sessionId = session.data.id;
      if (options.signal?.aborted) throw new RunCancelledError();
      const stream = await client.sessions.createTurnStream(sessionId, {
        input: [{ type: "user.message", content: prompt }],
      }, requestOptions);
      for await (const event of stream) {
        if (options.signal?.aborted) throw new RunCancelledError();
        onEvent(event);
        if (event.type === "turn.done") {
          terminal = true;
          if (event.state.status === "error")
            throw new Error(`TrueForge turn failed: ${event.state.message}`);
          if (event.state.status === "cancelled") throw new RunCancelledError();
          if (event.state.status !== "done") throw new Error("Unknown TrueForge terminal state");
          return sessionId;
        }
      }
      throw new Error("TrueForge stream ended before terminal success");
    } catch (error) {
      // Aborting SSE alone does not stop the server-side agent. Cancel its session too.
      if (sessionId && !terminal) {
        try {
          await client.sessions.cancel(sessionId, {}, { timeoutInSeconds: 10, maxRetries: 0 });
        } catch {
          cleanupConfirmed = false;
        }
      }
      await options.onAttemptFailed?.();
      if (!cleanupConfirmed) throw new Error("Could not confirm TrueForge stopped. No fallback was started; stop the local runtime before retrying.");
      if (options.signal?.aborted || error instanceof RunCancelledError) throw new RunCancelledError();
      if (attempt + 1 === models.length) throw error;
      options.onFallback?.(models[attempt + 1]);
    }
  }
  throw new Error("No model configured");
}
