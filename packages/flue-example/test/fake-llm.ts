// The fake model these tests use: the shared @statewalker/fake-openai endpoint, under the names
// the tests were written with.
import { type ChatRequest, startFakeOpenAi, type Turn } from "@statewalker/fake-openai";

/** One chat-completions request the fake model received. */
export type FakeLlmRequest = ChatRequest;

/** A scripted turn: a text reply, or one tool call. */
export type FakeTurn = Turn;

/** The fake endpoint, answering each request with `reply`; see startFakeOpenAi. */
export function startFakeLlm(
  reply: (req: FakeLlmRequest) => FakeTurn,
  opts: { delayMs?: number } = {},
) {
  return startFakeOpenAi({ reply, delayMs: opts.delayMs });
}
