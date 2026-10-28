// pi's agent loop in a Durable Object: each prompt runs the model and its tool calls, and the
// transcript is kept in the object's storage, so it survives a restart. Adapted from celld's
// `examples/pi`, which needs the unreleased PiHarness of the `agents` package; this one uses pi's
// own published packages.
import { DurableObject } from "cloudflare:workers";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, Type } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

function modelsFor(env) {
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "endpoint",
      // The OpenAI client needs some key; a local endpoint ignores it.
      auth: {
        apiKey: {
          name: "endpoint",
          resolve: async () => ({ auth: { apiKey: env.PI_API_KEY || "none" } }),
        },
      },
      models: [
        {
          id: env.PI_MODEL,
          name: env.PI_MODEL,
          api: "openai-completions",
          provider: "endpoint",
          baseUrl: env.PI_BASE_URL,
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
  return models;
}

// A tool the model can call: what the object knows about where it runs.
const whereAmI = {
  name: "where_am_i",
  label: "Where am I",
  description: "Tells where this agent runs",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text", text: "a Durable Object on cellb" }],
    details: {},
  }),
};

export class PiAgent extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const models = modelsFor(env);
    this.agent = new Agent({
      initialState: {
        systemPrompt: "You are a helpful assistant. Use your tools.",
        model: models.getModel("endpoint", env.PI_MODEL),
        tools: [whereAmI],
      },
      streamFn: models.streamSimple.bind(models),
    });
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get("messages");
      if (saved) this.agent.state.messages = saved;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/messages") return Response.json(this.agent.state.messages);
    await this.agent.prompt(url.searchParams.get("q") ?? "ping");
    const messages = this.agent.state.messages;
    await this.ctx.storage.put("messages", messages);
    const last = messages.at(-1);
    const reply = (last?.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    const failed = last?.stopReason === "error";
    return Response.json(
      {
        reply,
        error: failed ? last.errorMessage : undefined,
        toolCalls: messages
          .filter((m) => m.role === "assistant")
          .flatMap((m) =>
            m.content.filter((part) => part.type === "toolCall").map((part) => part.name),
          ),
        messages: messages.length,
      },
      { status: failed ? 502 : 200 },
    );
  }
}

export default {
  fetch(request, env) {
    return env.PI_AGENT.getByName("local-pi").fetch(request);
  },
};
