import { test } from "@playwright/test";

// Feasibility of a SYNCHRONOUS file API in a worker over an ASYNCHRONOUS store in another
// thread (here the page's main thread, with OPFS's async API): SharedArrayBuffer + Atomics.wait
// in the worker, Atomics.notify from the main thread. This is how a SQLite VFS could put its
// persistence in any FilesApi (OPFS, File System Access, IndexedDB). Needs cross-origin
// isolation, which the ServiceWorker of /__cellb/ provides.
test("sync worker reads over an async main-thread store (SharedArrayBuffer + Atomics)", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto("/__cellb/emdash.html");
  await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 60_000 });
  const out = await page.evaluate(async () => {
    // The async store: one OPFS file, 4 MiB, read by range.
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle("bridge-probe.bin", { create: true });
    const w = await fh.createWritable();
    await w.write(new Uint8Array(4 * 1024 * 1024).map((_, i) => i % 253));
    await w.close();
    const sab = new SharedArrayBuffer(8 + 64 * 1024); // [state, length] + payload
    const ctl = new Int32Array(sab, 0, 2);
    const payload = new Uint8Array(sab, 8);
    const src = `onmessage = (e) => {
      const sab = e.data; const ctl = new Int32Array(sab, 0, 2); const payload = new Uint8Array(sab, 8);
      const readSync = (offset, length) => {           // what a VFS xRead would call
        postMessage({ offset, length });
        Atomics.wait(ctl, 0, 0);                          // block until the store answers
        const n = ctl[1]; const out = payload.slice(0, n); Atomics.store(ctl, 0, 0); return out;
      };
      const t = performance.now(); let ok = 0;
      for (let i = 0; i < 2000; i++) { const off = (i * 4096 * 7) % (4 * 1024 * 1024 - 4096); const b = readSync(off, 4096); if (b[0] === off % 253) ok++; }
      postMessage({ done: true, ok, ms: performance.now() - t });
    };`;
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    const file = await fh.getFile();
    return await new Promise((resolve) => {
      worker.onmessage = async (e) => {
        if (e.data.done) return resolve(e.data);
        const { offset, length } = e.data;
        const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
        payload.set(bytes);
        ctl[1] = bytes.length;
        Atomics.store(ctl, 0, 1);
        Atomics.notify(ctl, 0);
      };
      worker.postMessage(sab);
    });
  });
  console.log(JSON.stringify(out));
});
