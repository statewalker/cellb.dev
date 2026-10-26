import { env } from "cloudflare:workers";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { setProvider } from "@flue/runtime";
import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";
import { Assistant } from "./agents/assistant.ts";

// The model endpoint comes from the Worker's env, read while the module is evaluated.
setProvider(
  createProvider({
    id: "local",
    // The OpenAI client needs some key; a local endpoint ignores it.
    auth: { apiKey: { name: "local", resolve: async () => ({ auth: { apiKey: "local" } }) } },
    models: [
      {
        id: "tiny",
        name: "Local OpenAI-compatible model",
        api: "openai-completions",
        provider: "local",
        baseUrl: String(env.LLM_BASE_URL),
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 1024,
      },
    ],
    api: openAICompletionsApi(),
  }),
);

const app = new Hono();
app.route("/agents/assistant", createAgentRouter(Assistant));
app.get("/ping", (c) => c.text("pong"));

export default app;
