// P04c — page: spawns the cell worker, mounts it behind the same-origin ServiceWorker.
import { SwHttpAdapter } from "@statewalker/webrun-http-browser/sw";
import { connectRuntime } from "../src/index.js";

async function boot() {
  const cellWorker = new Worker(new URL("./cell-worker.ts", import.meta.url), { type: "module" });
  const { port1, port2 } = new MessageChannel();
  await new Promise<void>((resolve, reject) => {
    cellWorker.addEventListener("message", (e) => {
      if (e.data?.type === "cells-booted")
        cellWorker.postMessage({ type: "cells-connect", port: port2 }, [port2]);
      if (e.data?.type === "cells-ready") resolve();
    });
    cellWorker.addEventListener("error", (e) => reject(e.error ?? new Error(e.message)));
  });
  const remote = await connectRuntime(port1);

  const adapter = new SwHttpAdapter({
    key: "cells",
    serviceWorkerUrl: new URL("./sw-worker.js", location.href).toString(),
  });
  await adapter.start();
  // Everything under /cells/ is served by the Worker module running in the cell worker.
  const { baseUrl } = await adapter.register("cells/", async (req: Request) => {
    const rest = req.url.slice(baseUrl.length - 1); // keep the leading "/"
    // Streams the body through (Chromium requires `duplex: "half"` for a stream body).
    return remote.fetch(
      new Request(new URL(rest, location.origin), {
        method: req.method,
        headers: req.headers,
        body: req.body,
        duplex: "half",
      } as RequestInit),
    );
  });
  Object.assign(window, { __cells: remote, __cellsBase: baseUrl });
  document.body.dataset.ready = "true";
}

(window as any).__cellsReady = boot().catch((e) => {
  document.body.dataset.error = String(e?.stack ?? e);
  throw e;
});
