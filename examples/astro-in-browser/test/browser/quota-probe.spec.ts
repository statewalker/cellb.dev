import { test } from "@playwright/test";

// What an OPFS SyncAccessHandle does past the origin's quota: SQLite's opfs-sahpool reports a
// short write as "Unknown write() failure".
test("OPFS writes past the quota", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/__cellb/app-src/list.json"); // a page of the origin with no script
  const out = await page.evaluate(async () => {
    const src = `onmessage = async () => {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle("quota-probe.bin", { create: true });
      const sah = await fh.createSyncAccessHandle();
      const chunk = new Uint8Array(64 * 1024 * 1024).fill(7);
      const log = [];
      let at = 0;
      for (let i = 0; i < 40; i++) {
        try {
          const n = sah.write(chunk, { at });
          at += n;
          if (n !== chunk.length) { log.push("short write: " + n + " of " + chunk.length + " at " + at); break; }
        } catch (e) { log.push("threw " + e.name + ": " + e.message + " at " + at); break; }
      }
      sah.flush(); sah.close();
      await root.removeEntry("quota-probe.bin");
      postMessage({ log, writtenMB: Math.round(at / 1e6) });
    };`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    const est = await navigator.storage.estimate();
    const r = await new Promise((res) => { w.onmessage = (e) => res(e.data); w.postMessage(0); });
    return { quotaMB: Math.round((est.quota ?? 0) / 1e6), ...(r as object) };
  });
  console.log(JSON.stringify(out));
});
