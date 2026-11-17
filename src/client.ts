type TrueForgeClient = InstanceType<
  typeof import("@truefoundry/trueforge-sdk", {
    with: { "resolution-mode": "import" }
  }).TrueForge
>;
function isEditorReview(call: {
  toolInfo: {type: string; name: string; serverName?: string};
  function: {arguments: string};
}): boolean {
  const info = call.toolInfo;
  if (info.type === "mcp")
    return info.serverName === "fakefoundy-editor" && info.name === "review_staged_edits";
  if (info.type !== "truefoundry-system" || info.name !== "call_tool") return false;
  try {
    const args = JSON.parse(call.function.arguments);
    return args?.mcp_server === "fakefoundy-editor" && args.tool_name === "review_staged_edits"
      && args.input !== null && typeof args.input === "object" && !Array.isArray(args.input)
      && Object.keys(args.input).length === 0;
  } catch { return false; }
}
export const instructions = [
  "You are FakeFoundy, a workspace coding assistant. Use only the editor MCP tools for workspace work, never call model providers directly.",
  "Use the supplied workspace context first. For a multi-file request, identify likely implementation, test and guide paths from that context and use any marked complete files directly as original source for propose_patch. Do not spend turns rereading them. For excerpts missing a needed anchor, call read_related_files with those paths in one request. If a target is missing or too large, search for the specific unresolved symbol and read its range. Do not page through a file looking for an anchor.",
  "Stage each supported part as soon as you have a unique anchor. Do not postpone one file while researching a different file. Issue independent tool calls together when possible. Follow the repository's existing registration and test patterns. Consider the actual data types, fixtures and command entry point. Complete all requested files before review.",
  "Use propose_patch for bounded, disjoint changes against ORIGINAL disk text; same-file patches compose. Read tools still show original content, not staged replacements. Preserve unrelated code and tests. Full-file propose_edit is disabled. For inline tasks use propose_selection with replacement text only.",
  "Tool JSON text fields are strings: use actual newline characters in old_text/new_text, encoded once for JSON transport. Never double-escape newlines into literal backslash-n characters. Copy a short unique original anchor exactly, including indentation. When a patch errors, follow its specific guidance and correct the argument; do not restart discovery or repeat an unchanged failing call. Stop and explain an unresolved blocker after two corrected failures.",
  "After staging changes, call the directly attached review_staged_edits tool exactly once (never via a generic wrapper) for the current batch before finishing; the harness pauses for native approval. If denied, do not recreate those edits unless the user asks. All proposals require editor review; never claim pending edits were applied. Summarize staged files and remaining caveats when finished.",
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
export class UserQuestionError extends Error {
  constructor(message: string) { super(message); this.name = "UserQuestionError"; }
}
export interface RunOptions {
  signal?: AbortSignal;
  /** Native harness review of a staged batch. Missing callback denies. */
  onApproval?: () => Promise<boolean>;
  /** Explicit user answer to a verified TrueForge built-in question; undefined cancels. */
  onQuestion?: (question: string) => Promise<string | undefined>;
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
          config: {generativeUi: {enabled:false}},
          model: { name: models[attempt] },
          mcpServers: [{ name: "fakefoundy-editor", preloadTools: ["read_related_files", "propose_selection", "propose_patch", "review_staged_edits"], disableTools: ["read_file", "propose_edit"], requireApprovalForTools: ["review_staged_edits"] }],
        } },
      }, requestOptions);
      sessionId = session.data.id;
      if (options.signal?.aborted) throw new RunCancelledError();
      const stream = await client.sessions.createTurnStream(sessionId, {
        input: [{ type: "user.message", content: prompt }],
      }, requestOptions);
      let turnId: string | undefined;
      const reviewCalls = new Set<string>();
      const decided = new Set<string>();
      const answered = new Set<string>();
      for await (const event of stream) {
        if (options.signal?.aborted) throw new RunCancelledError();
        onEvent(event);
        if (event.type === "turn.created") turnId = event.turnId;
        if (event.type === "model.message") for (const call of event.toolCalls ?? []) {
          if (isEditorReview(call))
            reviewCalls.add(`${event.threadId}:${event.id}:${call.id}`);
        }
        if (event.type === "tool.approval_required") {
          if (!turnId) throw new Error("Approval arrived without a turn identity");
          for (const call of event.toolCalls) {
            const key = `${event.threadId}:${call.sourceEventId}:${call.id}`;
            if (decided.has(key)) continue;
            let allowed = false;
            // SSE may carry only deltas, not the final enriched model.message.
            // Resolve the authoritative persisted event rather than trusting a tool name delta.
            if (!reviewCalls.has(key)) {
              let events = await client.sessions.listTurnEvents(sessionId, turnId,
                {order:"desc",limit:100}, {...requestOptions, timeoutInSeconds:10});
              for (let page = 0; page < 10; page++) {
                const source = events.data.find(e => e.id === call.sourceEventId);
                if (source) {
                  if (source.type === "model.message" && source.threadId === event.threadId) {
                    const tool = source.toolCalls?.find(t => t.id === call.id);
                    if (tool && isEditorReview(tool))
                      reviewCalls.add(key);
                  }
                  break;
                }
                if (!events.hasNextPage()) break;
                events = await events.getNextPage();
              }
            }
            if (reviewCalls.has(key) && options.onApproval) {
              allowed = await awaitReview(options.onApproval(), options.signal);
            }
            if (options.signal?.aborted) throw new RunCancelledError();
            await client.sessions.createTurnEvents(sessionId, turnId, { events: [{
              type: "user.tool_approval", threadId: event.threadId, toolCallId: call.id,
              approval: allowed ? {status: "allow"} : {status: "deny", reason: "Editor review denied or unavailable"},
            }] }, requestOptions);
            decided.add(key);
          }
        }
        if (event.type === "tool.response_required") {
          if (!turnId || !event.toolCalls.length) throw new UserQuestionError("TrueForge requested input without a valid turn/tool identity");
          for (const call of event.toolCalls) {
            const key=`${event.threadId}:${call.sourceEventId}:${call.id}`;
            if (answered.has(key)) continue;
            // The authoritative stored message identifies the built-in; never trust a streamed name delta.
            let events=await client.sessions.listTurnEvents(sessionId,turnId,
              {order:"desc",limit:100},{...requestOptions,timeoutInSeconds:10});
            let question: string | undefined;
            for (let page=0;page<10;page++) {
              const source=events.data.find(e=>e.id===call.sourceEventId);
              if (source) {
                if (source.type==="model.message" && source.threadId===event.threadId) {
                  const tool=source.toolCalls?.find(t=>t.id===call.id);
                  if (tool?.toolInfo.type==="truefoundry-system" && tool.toolInfo.name==="ask_user_question") {
                    try {
                      const args: unknown=JSON.parse(tool.function.arguments);
                      if (args && typeof args==="object" && "question" in args && typeof args.question==="string" && args.question.trim() && args.question.length<=8000) {
                        question=args.question;
                        if ("options" in args && args.options!==undefined) {
                          if (!Array.isArray(args.options) || args.options.length>20 || args.options.some(option=>typeof option!=="string" || option.length>500)) question=undefined;
                          else if (args.options.length) question+=`\n\nOptions:\n${args.options.map(option=>`- ${option}`).join("\n")}`;
                        }
                        if (question && question.length>8000) question=undefined;
                      }
                    } catch { /* malformed arguments fail closed below */ }
                  }
                }
                break;
              }
              if (!events.hasNextPage()) break;
              events=await events.getNextPage();
            }
            if (!question) throw new UserQuestionError("TrueForge requested an unsupported or malformed client-side tool response; no action was taken");
            if (!options.onQuestion) throw new UserQuestionError(`TrueForge needs a user answer: ${question}`);
            const answer=await awaitReview(options.onQuestion(question),options.signal);
            if (options.signal?.aborted || answer===undefined) throw new RunCancelledError("Question dismissed; run cancelled");
            if (!answer.trim() || answer.length>16000) throw new UserQuestionError("Question answer must contain 1–16000 characters; no answer was sent");
            await client.sessions.createTurnEvents(sessionId,turnId,{events:[{
              type:"user.tool_response",threadId:event.threadId,toolCallId:call.id,content:answer,
            }]},requestOptions);
            answered.add(key);
          }
        }
        if (event.type === "turn.done") {
          if (event.state.status === "done" && event.state.requiredActions?.length)
            throw new Error("TrueForge ended with unresolved required actions; not completed");
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
      if (error instanceof UserQuestionError || attempt + 1 === models.length) throw error;
      options.onFallback?.(models[attempt + 1]);
    }
  }
  throw new Error("No model configured");
}

/** A dismissed or stalled UI must not prevent cancellation/timeout cleanup. */
async function awaitReview<T>(review: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return review;
  if (signal.aborted) throw new RunCancelledError();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new RunCancelledError()); };
    signal.addEventListener("abort", abort, {once:true});
    review.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => {
      signal.removeEventListener("abort", abort); reject(error);
    });
  });
}
