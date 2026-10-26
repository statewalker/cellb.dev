import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { bundleWorkerForBrowser } from "@statewalker/cellb/node";
import { startFakeLlm } from "../fake-llm.ts";

// The app as Flue's own Cloudflare build emits it, bundled once more for a browser realm and
// run by cellb in a Dedicated Worker (SQLite WASM on OPFS), against the fake model endpoint.
const built = join(import.meta.dirname, "../../dist/flue_example");

test("a Flue agent app runs on cellb in a browser", async ({ page }) => {
  test.setTimeout(120_000);
  if (!existsSync(join(built, "wrangler.json")))
    throw new Error("run `vite build` first (pnpm test:browser does)");
  // The answer names the question it answers, so each conversation's reply is its own.
  const llm = await startFakeLlm(
    (req) => {
      const question = req.messages.find((m) => m.role === "user")?.content;
      const last = req.messages.at(-1);
      if (last?.role === "tool")
        return {
          text: `${JSON.stringify(question)}: the answer is ${JSON.stringify(last.content)}.`,
        };
      return { tool: "lookup_answer" };
    },
    { delayMs: 100 },
  );
  try {
    const config = JSON.parse(readFileSync(join(built, "wrangler.json"), "utf8"));
    config.vars = { ...config.vars, LLM_BASE_URL: llm.baseUrl };
    const bundle = await bundleWorkerForBrowser(join(built, config.main), { nodeCompat: true });
    await page.goto("/");
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    const r = await page.evaluate((job) => (window as any).__runFlue(job), {
      config,
      bundle,
      run: Date.now().toString(36),
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.unsupported).toEqual([]);
    expect(r.ping).toBe("pong");
    expect(r.reply).toContain("42");
    expect(r.roles[0]).toBe("user");
    expect(r.roles.at(-1)).toBe("assistant");
    expect(r.sawLive).toBe(true);
    expect(r.liveReply).toContain("42");
    expect(r.concurrent).toEqual([
      { text: expect.stringMatching(/question-a.*42/) },
      { text: expect.stringMatching(/question-b.*42/) },
    ]);
    // Each conversation holds its own question and answer only.
    for (const [own, other] of [
      ["a", "b"],
      ["b", "a"],
    ]) {
      const h: string[] = r.histories[own];
      expect(h.join("\n")).toContain(`question-${own}`);
      expect(h.join("\n")).not.toContain(`question-${other}`);
      expect(h.filter((t) => t.startsWith("user:"))).toHaveLength(1);
    }
    expect(r.reloaded).toEqual(r.roles);
    // The two ran at once: each one's first model call came before the other's second.
    const order = llm.requests
      .map(
        (q) => /question-[ab]/.exec(JSON.stringify(q.messages.find((m) => m.role === "user")))?.[0],
      )
      .filter(Boolean);
    expect(order.slice(0, 2).sort()).toEqual(["question-a", "question-b"]);
    // Every conversation went through the model twice: the tool call, then the answer.
    expect(llm.requests.length).toBe(8);
  } finally {
    await llm.close();
  }
});
