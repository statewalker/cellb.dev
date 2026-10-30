import { expect, test } from "@playwright/test";

// The package store on its own: PUT, HEAD and ranged GET against the Durable Object.
test("the package store Durable Object stores and serves ranges", async ({ context }) => {
  test.setTimeout(240_000);
  const host = await context.newPage();
  host.on("console", (m) => /shard|cellb|error/i.test(m.text()) && console.log(`[host ${m.type()}] ${m.text().slice(0, 600)}`));
  await host.goto("/__cellb/emdash.html");
  await host.waitForFunction(() => /package store .* ready/.test(document.getElementById("log")?.textContent ?? "") || document.body.dataset.error, null, { timeout: 120_000 });
  const out = await host.evaluate(async () => {
    const base = `${location.origin}/__cellb/projects/pkgstore/files/test/blob.bin`;
    const data = new Uint8Array(600_000).map((_, i) => i % 251);
    const put = await fetch(base, { method: "PUT", body: data });
    const head = await fetch(base, { method: "HEAD" });
    const ranged = await fetch(base, { headers: { range: "bytes=262140-262150" } });
    const rb = new Uint8Array(await ranged.arrayBuffer());
    const whole = await fetch(base);
    const wb = new Uint8Array(await whole.arrayBuffer());
    return {
      put: put.status,
      head: [head.status, head.headers.get("content-length")],
      ranged: [ranged.status, [...rb].join(","), (await (ranged.ok ? Promise.resolve("") : ranged.text()))],
      expected: [...data.subarray(262140, 262151)].join(","),
      whole: [whole.status, wb.length, wb.every((v, i) => v === data[i])],
      putText: put.ok ? "" : await put.text(),
    };
  });
  console.log(JSON.stringify(out));
  expect(out.put).toBe(204);
  expect(out.ranged[1]).toBe(out.expected);
  expect(out.whole[2]).toBe(true);
});
