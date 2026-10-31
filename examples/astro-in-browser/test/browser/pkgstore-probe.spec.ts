import { expect, test } from "@playwright/test";

// The package store on its own: PUT, HEAD and ranged GET against the Durable Object.
test("the package store Durable Object stores and serves ranges", async ({ context }) => {
  test.setTimeout(240_000);
  const host = await context.newPage();
  host.on(
    "console",
    (m) =>
      /shard|cellb|error/i.test(m.text()) &&
      console.log(`[host ${m.type()}] ${m.text().slice(0, 600)}`),
  );
  await host.goto("/__cellb/emdash.html?store");
  await host.waitForFunction(
    () =>
      /package store .* ready/.test(document.getElementById("log")?.textContent ?? "") ||
      document.body.dataset.error,
    null,
    { timeout: 120_000 },
  );
  const out = await host.evaluate(async () => {
    const base = `${location.origin}/__cellb/projects/pkgstore/files/test/blob.bin`;
    const data = new Uint8Array(8_000_000).map((_, i) => i % 251);
    const put = await fetch(base, { method: "PUT", body: data });
    const head = await fetch(base, { method: "HEAD" });
    const ranged = await fetch(base, { headers: { range: "bytes=262140-262150" } });
    const rb = new Uint8Array(await ranged.arrayBuffer());
    const whole = await fetch(base);
    const wb = new Uint8Array(await whole.arrayBuffer());
    return {
      put: put.status,
      head: [head.status, head.headers.get("content-length")],
      ranged: [
        ranged.status,
        [...rb].join(","),
        await (ranged.ok ? Promise.resolve("") : ranged.text()),
      ],
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

// The package store under the load of a cold build, in seconds: concurrent PUTs of 5–20 MB
// packs and ranged GETs of the packs already stored, with the LTX store's automatic
// compaction on. PKGSTORE_PACKS (default 24) and PKGSTORE_CONCURRENCY (default 4); with
// PKGSTORE_PACKS=80 PKGSTORE_CONCURRENCY=8 it runs past the storage of a Playwright context.
test("the package store under concurrent PUTs, ranged GETs and compaction", async ({ context }) => {
  test.setTimeout(600_000);
  const host = await context.newPage();
  const seen: string[] = [];
  const keep = (line: string) => {
    if (/ltx|cellb|error|transaction|DataView|SyncAccess|quota/i.test(line)) {
      seen.push(line);
      console.log(line.slice(0, 900));
    }
  };
  host.on("console", (m) => keep(`[host ${m.type()}] ${m.text()}`));
  host.on("pageerror", (e) => keep(`[pageerror] ${e.message}`));
  host.on("worker", (w) =>
    (w as any).on?.("console", (m: any) => keep(`[worker ${m.type()}] ${m.text()}`)),
  );
  await host.goto("/__cellb/emdash.html?store");
  await host.waitForFunction(
    () =>
      /package store .* ready/.test(document.getElementById("log")?.textContent ?? "") ||
      document.body.dataset.error,
    null,
    { timeout: 120_000 },
  );
  const packs = Number(process.env.PKGSTORE_PACKS ?? 24);
  const concurrency = Number(process.env.PKGSTORE_CONCURRENCY ?? 4);
  const out = await host.evaluate(
    async ({ packs, concurrency }) => {
      const base = `${location.origin}/__cellb/projects/pkgstore/files/lab`;
      // Deterministic, little-compressible bytes (as packed tarballs are).
      const bytesOf = (n: number, size: number) => {
        const b = new Uint8Array(size);
        let x = (n + 1) * 2654435761;
        for (let i = 0; i < size; i++) {
          x ^= x << 13;
          x ^= x >>> 17;
          x ^= x << 5;
          b[i] = x & 0xff;
        }
        return b;
      };
      const sizeOf = (n: number) => (5 + ((n * 7) % 16)) * 1_000_000;
      const stored: number[] = [];
      const errors: string[] = [];
      const t0 = performance.now();
      const withTimeout = (p: Promise<Response>, what: string) =>
        Promise.race([
          p,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${what}: no answer in 60 s`)), 60_000),
          ),
        ]);
      let next = 0;
      let gets = 0;
      const lane = async () => {
        while (next < packs) {
          const n = next++;
          const data = bytesOf(n, sizeOf(n));
          try {
            const put = await withTimeout(
              fetch(`${base}/${n}.pack`, { method: "PUT", body: data }),
              `PUT ${n}`,
            );
            if (put.status !== 204) errors.push(`PUT ${n}: ${put.status} ${await put.text()}`);
            else stored.push(n);
          } catch (e) {
            errors.push(String(e));
          }
          // Ranged reads of what is stored, as the builder reads packs.
          for (let k = 0; k < 4 && stored.length; k++) {
            const m = stored[(n * 31 + k * 17) % stored.length];
            const size = sizeOf(m);
            const start = ((n + 1) * (k + 3) * 104729) % (size - 70_000);
            try {
              const r = await withTimeout(
                fetch(`${base}/${m}.pack`, {
                  headers: { range: `bytes=${start}-${start + 65535}` },
                }),
                `GET ${m}`,
              );
              const got = new Uint8Array(await r.arrayBuffer());
              const want = bytesOf(m, size).subarray(start, start + 65536);
              gets++;
              if (
                r.status !== 206 ||
                got.length !== want.length ||
                got.some((v, i) => v !== want[i])
              )
                errors.push(`GET ${m} @${start}: ${r.status}, ${got.length} bytes, wrong content`);
            } catch (e) {
              errors.push(String(e));
            }
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, lane));
      // Integrity, whatever failed above: every pack a PUT reported stored reads back exactly
      // (its first, a middle and its last 64 KiB).
      const corrupt: string[] = [];
      for (const m of stored) {
        const size = sizeOf(m);
        const want = bytesOf(m, size);
        for (const start of [0, Math.floor(size / 2), size - 65536]) {
          const r = await fetch(`${base}/${m}.pack`, {
            headers: { range: `bytes=${start}-${start + 65535}` },
          });
          const got = new Uint8Array(await r.arrayBuffer());
          if (r.status !== 206 || got.some((v, i) => v !== want[start + i]))
            corrupt.push(`${m}.pack @${start}: ${r.status}, ${got.length} bytes`);
        }
      }
      const estimate = await navigator.storage.estimate();
      return {
        stored: stored.length,
        gets,
        errors,
        corrupt,
        seconds: Math.round((performance.now() - t0) / 1000),
        usageMB: Math.round((estimate.usage ?? 0) / 1e6),
        quotaMB: Math.round((estimate.quota ?? 0) / 1e6),
      };
    },
    { packs, concurrency },
  );
  console.log(JSON.stringify(out, null, 1));
  // Nothing stored is ever lost or damaged, even past the quota.
  expect(out.corrupt).toEqual([]);
  if (process.env.PKGSTORE_PACKS) {
    // Beyond what the context's storage holds: only PUTs may fail, for want of space (a
    // failed commit resets the Durable Object, as in workerd), never a read.
    expect(out.errors.filter((e) => !/^PUT /.test(e))).toEqual([]);
    expect(seen.filter((l) => /no answer|short read/.test(l))).toEqual([]);
  } else {
    expect(out.errors).toEqual([]);
    expect(out.stored).toBe(packs);
    expect(seen.filter((l) => /failed at|no answer|transaction/.test(l))).toEqual([]);
  }
});
