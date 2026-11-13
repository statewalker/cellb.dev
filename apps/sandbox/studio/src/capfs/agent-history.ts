// Vendored from statewalker-sandbox/apps/flue-capfs-do (2641939, 2026-11-11); changes marked "studio:".
// What an agent session keeps between runs (src/agent-loop.ts), apart so it can be unit-tested.

export interface HistoryMessage {
  role: string;
  stopReason?: string;
}

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/**
 * A history a provider accepts: at most `maxMessages` and `maxBytes` (UTF-8 JSON), no aborted
 * or failed replies, and starting with a user message (never with a tool result whose call was
 * dropped, or with an assistant message).
 */
export function trimHistory<M extends HistoryMessage>(
  messages: M[],
  maxMessages: number,
  maxBytes: number,
): M[] {
  let keep = messages
    .filter(
      (m) => !(m.role === "assistant" && (m.stopReason === "aborted" || m.stopReason === "error")),
    )
    .slice(-maxMessages);
  const fromUser = (ms: M[]) => {
    const i = ms.findIndex((m) => m.role === "user");
    return i < 0 ? [] : ms.slice(i);
  };
  keep = fromUser(keep);
  while (keep.length && bytes(keep) > maxBytes)
    keep = fromUser(keep.slice(Math.ceil(keep.length / 4)));
  return keep;
}
