"use agent";
import { useModel, useTool } from "@flue/runtime";
import { getDurableObjectIdentity } from "@flue/runtime/cloudflare";

export function Assistant() {
  useModel("local/tiny");
  useTool({
    name: "lookup_answer",
    description: "Returns the answer to the ultimate question.",
    async run() {
      return { output: { answer: 42 } };
    },
  });
  // Reads the agent's identity the way tools and sandbox adapters do (Flue's context, an
  // AsyncLocalStorage), before and after an await: the tests check that concurrent
  // conversations each see their own.
  useTool({
    name: "whoami",
    description: "Returns the name of the conversation this agent serves.",
    async run() {
      const before = getDurableObjectIdentity().name;
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
      const after = getDurableObjectIdentity().name;
      return { output: { before, after } };
    },
  });
  return "You are a terse assistant. Use lookup_answer when asked for the answer.";
}
