import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { bundleWorkerForBrowser } from "@statewalker/cellb/node";
import { startFakeLlm } from "../fake-llm.ts";
import { whoamiScript, wrongIdentities } from "../whoami.ts";

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

// Tools and sandbox adapters find their agent through Flue's context (an AsyncLocalStorage):
// with many conversations at once in one browser runtime, each tool must see its own
// conversation, after an await too.
for (const conversations of [8, 32])
  test(`each of ${conversations} concurrent conversations' tool sees its own agent context`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const llm = await startFakeLlm(whoamiScript, { delayMs: 30 });
    try {
      const config = JSON.parse(readFileSync(join(built, "wrangler.json"), "utf8"));
      config.vars = { ...config.vars, LLM_BASE_URL: llm.baseUrl };
      const bundle = await bundleWorkerForBrowser(join(built, config.main), { nodeCompat: true });
      await page.goto("/");
      await page.waitForFunction(() => document.body.dataset.ready === "true");
      const browser = page.context().browser()!;
      await browser.startTracing(page, {
        path: `/tmp/claude-0/trace-${conversations}.json`,
        categories: ["disabled-by-default-v8.cpu_profiler", "v8"],
      });
      const r = await page.evaluate((job) => (window as any).__runFlue(job), {
        config,
        bundle,
        run: Date.now().toString(36),
        scenario: "whoami",
        conversations,
      });
      await browser.stopTracing();
      expect(r.ok, r.error).toBe(true);
      expect(r.problems).toEqual([]);
      expect(wrongIdentities(r.results)).toEqual([]);
    } finally {
      await llm.close();
    }
  });

// Flue's per-conversation queue on cellb's input gate: messages that arrive together all settle,
// none is lost, and the tool still sees its own conversation.
test("messages sent to one conversation at once all settle", async ({ page }) => {
  test.setTimeout(120_000);
  const llm = await startFakeLlm(whoamiScript, { delayMs: 30 });
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
      scenario: "one-conversation",
      messages: 4,
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.submissions).toBe(4);
    expect(r.users).toBe(4);
    expect(r.outcomes).toEqual(["completed", "completed", "completed", "completed"]);
    expect(wrongIdentities(r.replies.map((x: object) => ({ id: "one", ...x })))).toEqual([]);
  } finally {
    await llm.close();
  }
});

// Conversations in parallel threads: `shards` workers each host the app and own their share of
// the conversations (shardOf), and route the others to their owner over MessagePorts.
for (const shards of [1, 4])
  test(`32 conversations over ${shards} worker(s): each tool sees its own agent context`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const llm = await startFakeLlm(whoamiScript, { delayMs: 30 });
    try {
      const config = JSON.parse(readFileSync(join(built, "wrangler.json"), "utf8"));
      config.vars = { ...config.vars, LLM_BASE_URL: llm.baseUrl };
      const bundle = await bundleWorkerForBrowser(join(built, config.main), { nodeCompat: true });
      await page.goto("/");
      await page.waitForFunction(() => document.body.dataset.ready === "true");
      const r = await page.evaluate((job) => (window as any).__runFlueSharded(job), {
        config,
        bundle,
        run: Date.now().toString(36),
        shards,
        conversations: 32,
      });
      expect(r.ok, r.error).toBe(true);
      expect(r.problems).toEqual([]);
      expect(wrongIdentities(r.results)).toEqual([]);
    } finally {
      await llm.close();
    }
  });

// The app shared by the tabs of the origin (joinProjectShards / installProjectRouter): two tabs
// split its shards and talk to it through the ServiceWorker at once; when one tab closes, the
// other takes its shards, with their conversations.
test("tabs share the app: conversations from both, and one tab closing", async ({ context }) => {
  test.setTimeout(180_000);
  const llm = await startFakeLlm(whoamiScript, { delayMs: 30 });
  try {
    const config = JSON.parse(readFileSync(join(built, "wrangler.json"), "utf8"));
    const name = `flue-tabs-${Date.now().toString(36)}`;
    // The ServiceWorker passes /app/<name>/… on unchanged: the app mounts its routes there.
    config.vars = { ...config.vars, LLM_BASE_URL: llm.baseUrl, BASE_PATH: `/app/${name}` };
    const bundle = await bundleWorkerForBrowser(join(built, config.main), { nodeCompat: true });
    const job = { name, shards: 4, config, bundle };
    const owned = (p: Page) =>
      p.evaluate(() => (document.body.dataset.owned ?? "").split(",").filter(Boolean).map(Number));
    const open = async () => {
      const p = await context.newPage();
      await p.goto("/tabs.html");
      await p.waitForFunction(
        () => document.body.dataset.ready === "true" || document.body.dataset.error,
      );
      expect(await p.evaluate(() => document.body.dataset.error ?? null)).toBeNull();
      await p.evaluate((j) => (window as any).__join(j), job);
      return p;
    };

    const a = await open();
    await expect.poll(() => owned(a)).toEqual([0, 1, 2, 3]);
    const b = await open();
    await expect.poll(() => owned(b)).toEqual([1, 3]);
    await expect.poll(() => owned(a)).toEqual([0, 2]);

    const fromA = Array.from({ length: 8 }, (_, i) => `a-${i}`);
    const fromB = Array.from({ length: 8 }, (_, i) => `b-${i}`);
    const [ra, rb] = await Promise.all([
      a.evaluate((ids) => (window as any).__whoami(ids), fromA),
      b.evaluate((ids) => (window as any).__whoami(ids), fromB),
    ]);
    expect(wrongIdentities([...ra, ...rb])).toEqual([]);

    // Tab a closes as a user closes it: no code runs. Tab b takes shards 0 and 2, and the
    // conversations stored there with them.
    await a.close();
    await expect.poll(() => owned(b), { timeout: 30_000 }).toEqual([0, 1, 2, 3]);
    for (const id of fromA)
      expect(await b.evaluate((i) => (window as any).__history(i), id)).toEqual([
        "user",
        "assistant",
      ]);
    const again = await b.evaluate((ids) => (window as any).__whoami(ids), fromA);
    expect(wrongIdentities(again)).toEqual([]);
    // A tab that closes runs no code, so its shards cannot drain: a request still open into
    // them fails with ShardOwnerLostError (here a long-poll read the client had given up on,
    // which Flue logs). Nothing else may go wrong.
    const problems: string[] = await b.evaluate(() => (window as any).__problems());
    expect(problems.filter((p) => !/read failed[\s\S]*ShardOwnerLostError/.test(p))).toEqual([]);
  } finally {
    await llm.close();
  }
});
