// What the Agent tab shows of a run: the studio's progress events, then how it ended.
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; output: string }
  | { type: "done"; steps: number }
  | { type: "error"; message: string };
