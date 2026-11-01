import { test } from "@playwright/test";

test("probe the EmDash bundle's responses", async ({ context }) => {
  test.setTimeout(600_000);
  const host = await context.newPage();
  host.on(
    "console",
    (m) =>
      (m.type() === "error" || /\[shard\]|cellb:/.test(m.text())) &&
      console.log(`[host ${m.type()}] ${m.text().slice(0, 600)}`),
  );
  host.on("worker", (w) =>
    (w as any).on?.(
      "console",
      (m: any) =>
        m.type() !== "debug" && console.log(`[worker ${m.type()}] ${m.text().slice(0, 600)}`),
    ),
  );
  context.on("serviceworker", (w) =>
    (w as any).on?.("console", (m: any) =>
      console.log(`[sw ${m.type()}] ${m.text().slice(0, 800)}`),
    ),
  );
  await host.goto("/__cellb/emdash.html");
  await host.waitForFunction(
    () => document.body.dataset.ready === "true" || document.body.dataset.error,
    null,
    { timeout: 400_000, polling: 2000 },
  );
  const probe = (path: string, init?: RequestInit) =>
    host.evaluate(
      async ([p, i]) => {
        const t = performance.now();
        const ctl = new AbortController();
        setTimeout(() => ctl.abort(), 30_000);
        try {
          const r = await fetch(p as string, { ...(i as RequestInit), signal: ctl.signal });
          const head = Math.round(performance.now() - t);
          const body = await r.text();
          return `${p} ${r.status} ${[...r.headers].map(([k, v]) => `${k}=${v.slice(0, 60)}`).join(";")} headers ${head} ms, body ${body.length} B in ${Math.round(performance.now() - t)} ms: ${body.replace(/\s+/g, " ").slice(0, 160)}`;
        } catch (e) {
          return `${p} FAILED after ${Math.round(performance.now() - t)} ms: ${e}`;
        }
      },
      [path, init] as const,
    );
  for (const p of ["/_emdash/admin/setup", "/404", "/search"]) console.log(await probe(p));
  console.log(
    await probe("/_emdash/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-emdash-request": "1" },
      body: JSON.stringify({ title: "Built in the Browser", tagline: "t", includeContent: true }),
    }),
  );
  for (const p of ["/", "/posts", "/_emdash/admin"]) console.log(await probe(p));
});
