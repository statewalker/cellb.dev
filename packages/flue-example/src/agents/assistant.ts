"use agent";
import { useModel, useTool } from "@flue/runtime";

export function Assistant() {
  useModel("local/tiny");
  useTool({
    name: "lookup_answer",
    description: "Returns the answer to the ultimate question.",
    async run() {
      return { output: { answer: 42 } };
    },
  });
  return "You are a terse assistant. Use lookup_answer when asked for the answer.";
}
