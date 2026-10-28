import { afterEach, describe, expect, it } from "vitest";
import { type FakeOpenAi, startFakeOpenAi } from "../src/index.ts";

let fake: FakeOpenAi | undefined;
afterEach(() => fake?.close());

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/** The `data:` payloads of an SSE body, parsed (`[DONE]` kept as is). */
async function events(res: Response) {
  return (await res.text())
    .split("\n\n")
    .filter((e) => e.startsWith("data: "))
    .map((e) => e.slice(6))
    .map((d) => (d === "[DONE]" ? d : JSON.parse(d)));
}

describe("fake OpenAI endpoint", () => {
  it("answers chat completions with the default script: echo, tool call, tool result", async () => {
    fake = await startFakeOpenAi();
    const echo = await (
      await post(
        fake.chatUrl,
        { model: "m", messages: [{ role: "user", content: "hi" }] },
        {
          authorization: "Bearer k",
        },
      )
    ).json();
    expect(echo.choices[0].message).toEqual({ role: "assistant", content: "fake-model heard: hi" });
    expect(fake.authorizations).toEqual(["Bearer k"]);

    const tools = [{ type: "function", function: { name: "lookup" } }];
    const call = await (
      await post(fake.chatUrl, { model: "m", messages: [{ role: "user", content: "x" }], tools })
    ).json();
    expect(call.choices[0].finish_reason).toBe("tool_calls");
    expect(call.choices[0].message.tool_calls[0].function).toEqual({
      name: "lookup",
      arguments: "{}",
    });

    const done = await (
      await post(fake.chatUrl, {
        model: "m",
        tools,
        messages: [
          { role: "user", content: "x" },
          { role: "tool", tool_call_id: "c", content: "42" },
        ],
      })
    ).json();
    expect(done.choices[0].message.content).toBe("The tool said: 42");
    expect(fake.requests).toHaveLength(3);
  });

  it("streams text a word at a time, and tool calls as OpenAI does, with usage and [DONE]", async () => {
    fake = await startFakeOpenAi({
      reply: (req) =>
        req.tools
          ? { tools: [{ name: "a", args: { n: 1 } }, { name: "b" }] }
          : { text: "one two three" },
    });
    const text = await events(
      await post(fake.chatUrl, {
        model: "m",
        stream: true,
        messages: [{ role: "user", content: "x" }],
      }),
    );
    const words = text
      .filter((e) => e !== "[DONE]" && e.choices[0])
      .map((e) => e.choices[0].delta.content ?? "")
      .join("");
    expect(words).toBe("one two three");
    expect(text.at(-1)).toBe("[DONE]");
    expect(text.at(-2).usage.total_tokens).toBe(15);

    const calls = await events(
      await post(fake.chatUrl, {
        model: "m",
        stream: true,
        tools: [{ function: { name: "a" } }],
        messages: [{ role: "user", content: "x" }],
      }),
    );
    const deltas = calls.filter((e) => e !== "[DONE]" && e.choices[0]?.delta.tool_calls);
    const args = (i: number) =>
      deltas
        .flatMap((e) => e.choices[0].delta.tool_calls)
        .filter((c: { index: number }) => c.index === i)
        .map((c: { function: { arguments?: string } }) => c.function.arguments ?? "")
        .join("");
    expect(args(0)).toBe('{"n":1}');
    expect(args(1)).toBe("{}");
    expect(
      calls.find((e) => e !== "[DONE]" && e.choices[0]?.finish_reason)?.choices[0].finish_reason,
    ).toBe("tool_calls");
  });

  it("lists models, embeds, holds a response, and answers CORS preflights", async () => {
    fake = await startFakeOpenAi({ models: ["a", "b"] });
    const models = await (await fetch(`${fake.baseUrl}/models`)).json();
    expect(models.data.map((m: { id: string }) => m.id)).toEqual(["a", "b"]);

    const emb = await (
      await post(`${fake.baseUrl}/embeddings`, { model: "e", input: ["x", "y"] })
    ).json();
    expect(emb.data).toHaveLength(2);
    expect(Math.hypot(...emb.data[0].embedding)).toBeCloseTo(1);

    const held = fake.holdNext();
    const pending = post(fake.chatUrl, {
      model: "m",
      messages: [{ role: "user", content: "wait" }],
    });
    await held.arrived;
    held.release();
    expect((await (await pending).json()).choices[0].message.content).toBe(
      "fake-model heard: wait",
    );

    const pre = await fetch(fake.chatUrl, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
  });
});
