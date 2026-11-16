/** Display public assistant text/tool activity only, never hidden reasoning or raw payloads. */
export function streamText(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const e = event as Record<string, any>;
  if (e.type === "model.message.delta")
    return typeof e.content === "string" ? e.content : typeof e.refusal === "string" ? e.refusal : "";
  if (e.type === "model.message") {
    const tools = Array.isArray(e.toolCalls) ? e.toolCalls
      .map((t: any) => t?.function?.name).filter((n: unknown) => typeof n === "string") : [];
    return tools.length ? `\nTools: ${tools.join(", ")}\n` : "";
  }
  if (e.type === "tool.response") return "\nTool completed.\n";
  if (e.type === "turn.done") return `\nTurn ${e.state?.status ?? "finished"}.\n`;
  return "";
}

/** Tracks each thread's current message to avoid repeating a streamed final answer. */
export class StreamFormatter {
  private deltaThreads = new Set<string>();
  format(event: unknown): string {
    if (!event || typeof event !== "object") return "";
    const e = event as Record<string, any>;
    const thread = typeof e.threadId === "string" ? e.threadId : "main";
    if (e.type === "model.message.delta") {
      const text = streamText(event);
      if (text) this.deltaThreads.add(thread);
      return text;
    }
    if (e.type === "model.message") {
      const streamed = this.deltaThreads.delete(thread);
      const content = typeof e.content === "string" ? e.content : Array.isArray(e.content)
        ? e.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("") : "";
      const text = streamed ? "" : content || (typeof e.refusal === "string" ? e.refusal : "");
      return text + streamText(event);
    }
    return streamText(event);
  }
}
