type TrueForgeClient = InstanceType<
  typeof import("@truefoundry/trueforge-sdk", {
    with: { "resolution-mode": "import" }
  }).TrueForge
>;
export const instructions =
  "You are FakeFoundy, a workspace coding assistant. Use the editor MCP tools to discover and read relevant files before proposing changes. propose_edit only stages changes; never claim that pending edits were applied. Do not call model providers directly.";
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
