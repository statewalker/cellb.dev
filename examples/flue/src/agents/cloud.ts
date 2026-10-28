"use agent";
import { useModel, useTool } from "@flue/runtime";

// The same assistant on a Workers AI model: Flue's `cloudflare` provider calls `env.AI.run()`,
// which cellb serves from the OpenAI-compatible endpoint the host names (`ai` option).
export function Cloud() {
  useModel("cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  useTool({
    name: "lookup_answer",
    description: "Returns the answer to the ultimate question.",
    async run() {
      return { output: { answer: 42 } };
    },
  });
  return "You are a terse assistant. Use lookup_answer when asked for the answer.";
}
