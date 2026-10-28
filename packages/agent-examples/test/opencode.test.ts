import { lastUserText, startFakeOpenAi } from "@statewalker/fake-openai";
import { describe, expect, it } from "vitest";
import { loadExample } from "./load-example.ts";

// opencode's workerd SDK in a Durable Object on cellb (celld's examples/opencode, with the model
// from an OpenAI-compatible endpoint): a session is created, prompted, and answered by the fake
// model; the SDK's state lives in the object's SQLite.
describe("opencode on cellb", () => {
  it("creates a session, prompts it and reads the model's reply", async () => {
    const fake = await startFakeOpenAi({
      // opencode also asks the model for a session title; answer the prompt itself plainly.
      reply: (req) => ({ text: `opencode heard: ${lastUserText(req)}` }),
    });
    const { runtime, unsupported } = await loadExample("opencode", {
      OPENCODE_BASE_URL: fake.baseUrl,
    });
    try {
      expect(unsupported).toEqual([]);
      const res = await runtime.fetch(new Request("http://x/"));
      const body = (await res.json()) as {
        ok: boolean;
        model: { providerID: string; modelID: string };
        reply: string;
        error?: unknown;
        checks: { name: string; ok: boolean }[];
      };
      expect(res.status, JSON.stringify(body.error ?? body.checks)).toBe(200);
      expect(body.model).toEqual({ providerID: "endpoint", modelID: "fake-model" });
      expect(body.reply).toContain("opencode heard:");
      expect(body.reply).toContain("hello world");
      expect(body.checks.every((c) => c.ok)).toBe(true);
      expect(fake.requests.length).toBeGreaterThan(0);
      expect(fake.requests.every((r) => r.model === "fake-model")).toBe(true);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });
});
