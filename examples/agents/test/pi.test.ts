import { startFakeOpenAi } from "@statewalker/fake-openai";
import { describe, expect, it } from "vitest";
import { loadExample } from "./load-example.ts";

// pi's agent loop (@earendil-works/pi-agent-core) in a Durable Object on cellb, with the fake
// model: a prompt calls the agent's tool, the tool's answer comes back as the reply, and the
// transcript persists in the object's storage.
describe("pi on cellb", () => {
  it("runs a prompt through a tool call and keeps the transcript", async () => {
    const fake = await startFakeOpenAi();
    const { runtime, unsupported } = await loadExample("pi", { PI_BASE_URL: fake.baseUrl });
    try {
      expect(unsupported).toEqual([]);
      const res = await runtime.fetch(new Request("http://x/?q=where%20are%20you"));
      const body = (await res.json()) as { reply: string; toolCalls: string[]; error?: string };
      expect(res.status, body.error).toBe(200);
      expect(body.toolCalls).toEqual(["where_am_i"]);
      expect(body.reply).toBe("The tool said: a Durable Object on cellb");

      // Two model calls: the first offered the tool, the second carried its result.
      expect(fake.requests).toHaveLength(2);
      expect(fake.requests[0]?.model).toBe("fake-model");
      expect(fake.requests[0]?.tools?.map((t) => t.function.name)).toEqual(["where_am_i"]);
      expect(fake.requests[1]?.messages.some((m) => m.role === "tool")).toBe(true);

      // The transcript is in the object's storage: a second prompt continues it.
      const again = await runtime.fetch(new Request("http://x/?q=and%20now"));
      expect(again.status).toBe(200);
      const messages = (await (await runtime.fetch(new Request("http://x/messages"))).json()) as {
        role: string;
      }[];
      expect(messages.filter((m) => m.role === "user")).toHaveLength(2);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });
});
