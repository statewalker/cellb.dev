import type { FakeLlmRequest, FakeTurn } from "./fake-llm.ts";

/**
 * The whoami scenario: every conversation calls the `whoami` tool once and answers with its
 * result, `{ before, after }` — the conversation name the tool's agent context held before and
 * after an await. Run many conversations at once and each must see its own name.
 */
export const whoamiScript = (req: FakeLlmRequest): FakeTurn => {
  const last = req.messages.at(-1);
  if (last?.role === "tool") return { text: `whoami=${String(last.content)}` };
  return { tool: "whoami" };
};

export interface WhoamiResult {
  id: string;
  text?: string;
  error?: string;
}

/** The conversations whose tool saw another name (or failed), as "id: what it saw". */
export function wrongIdentities(results: WhoamiResult[]): string[] {
  const wrong: string[] = [];
  for (const r of results) {
    const seen = r.text ? JSON.parse(r.text.slice("whoami=".length)) : undefined;
    if (!seen || seen.before !== r.id || seen.after !== r.id)
      wrong.push(`${r.id}: ${r.error ?? JSON.stringify(seen)}`);
  }
  return wrong;
}
