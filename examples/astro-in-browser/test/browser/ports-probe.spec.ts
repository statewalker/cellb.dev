import { test } from "@playwright/test";

// Which requests leave a multiplexed port open in cellb's ServiceWorker → shard transport?
test("port leak per request kind", async ({ context }) => {
  test.setTimeout(240_000);
  const host = await context.newPage();
  await host.goto("/__cellb/emdash.html");
  await host.waitForFunction(
    () => /package store .* ready/.test(document.getElementById("log")?.textContent ?? ""),
    null,
    { timeout: 120_000 },
  );
  const out = await host.evaluate(async () => {
    const base = `${location.origin}/__cellb/projects/pkgstore/files/probe/x.bin`;
    await fetch(base, { method: "PUT", body: new Uint8Array(1000) });
    const res: Record<string, string> = {};
    for (const [kind, init] of [
      ["HEAD", { method: "HEAD" }],
      ["GET", {}],
      ["GET-404", {}],
      ["PUT", { method: "PUT", body: new Uint8Array(10) }],
    ] as const) {
      let fails = 0;
      let first = "";
      for (let i = 0; i < 1300; i++) {
        const url = kind === "GET-404" ? `${base}.missing` : base;
        const r = await fetch(url, init as RequestInit);
        if (r.status === 503) {
          fails++;
          first ||= `${i}: ${(await r.text()).slice(0, 120)}`;
        } else await r.arrayBuffer();
      }
      res[kind] = fails ? `${fails} failed, first at ${first}` : "ok";
      if (fails) break;
    }
    return res;
  });
  console.log(JSON.stringify(out, null, 1));
});
