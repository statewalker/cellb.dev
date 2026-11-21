// The page side: starts the Dedicated Worker that hosts the app and offers `window.__app`, a
// fetch-like call into it (the browser test drives the app through it).

type Reply = { status: number; contentType: string | null; body: ArrayBuffer } | { error: string };

let worker: Worker | undefined;
/** Calls waiting for an answer, failed when the worker errors. */
const pending = new Set<(error: string) => void>();

function call<T>(message: unknown, transfer: Transferable[] = []): Promise<T> {
  if (!worker) throw new Error("start the app first");
  const channel = new MessageChannel();
  const done = new Promise<T>((resolve) => {
    const fail = (error: string) => resolve({ ok: false, error } as T);
    pending.add(fail);
    channel.port1.onmessage = (e) => {
      pending.delete(fail);
      resolve(e.data as T);
    };
  });
  worker.postMessage(message, [channel.port2, ...transfer]);
  return done;
}

const app = {
  /** Loads the app in a new worker; `data` names its OPFS storage (the same name: a reload). */
  async start(data: string) {
    // Calls still waiting on the old worker are failed, not left hanging.
    for (const fail of pending) fail("the app was restarted");
    pending.clear();
    worker?.terminate();
    worker = new Worker(new URL("./app-worker.ts", import.meta.url), { type: "module" });
    // A worker that fails to load or throws at the top level answers nothing: report it.
    worker.onerror = (e) => {
      for (const reject of pending) reject(`worker error: ${e.message || "failed to load"}`);
      pending.clear();
    };
    return call<{ ok: boolean; error?: string; unsupported?: string[] }>({ type: "start", data });
  },
  /** A request to the app; the body comes back as text (JSON) or base64 (binary). */
  async fetch(path: string, init: { method?: string; body?: string; base64?: boolean } = {}) {
    const body = init.body
      ? init.base64
        ? Uint8Array.from(atob(init.body), (c) => c.charCodeAt(0)).buffer
        : new TextEncoder().encode(init.body).buffer
      : undefined;
    const r = await call<Reply>(
      { type: "fetch", path, method: init.method ?? "GET", body },
      body ? [body] : [],
    );
    if ("error" in r) return { status: 0, error: r.error };
    const bytes = new Uint8Array(r.body);
    const binary = !r.contentType?.includes("json") && !r.contentType?.startsWith("text");
    return {
      status: r.status,
      contentType: r.contentType,
      text: binary ? undefined : new TextDecoder().decode(bytes),
      size: bytes.byteLength,
      head: [...bytes.subarray(0, 8)],
    };
  },
  /** Closes the app (its storage stays): as when the tab goes away. */
  async stop() {
    if (!worker) return;
    await call({ type: "stop" });
    worker.terminate();
    worker = undefined;
  },
};

(window as unknown as { __app: typeof app }).__app = app;
document.body.dataset.ready = "true";
