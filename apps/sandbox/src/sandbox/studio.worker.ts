/// <reference lib="webworker" />
// The studio worker: the agents' side of the IDE, in a realm of its own (the app's Worker code
// runs in the runner, never here).
//
//   - It owns each project's files: the FilesApi a `mount` describes (sources.ts: a folder on
//     disk, memory, OPFS, S3, a composite). Nothing else holds them: the page, the runner and the
//     agents reach them only through capabilities (Biscuit tokens) the studio checks.
//   - It runs the studio Worker (studio/: Workspace and Agent cells) on CellB, with
//     `globalThis.cellbStudioHost` as its host: the store of each workspace, change notices,
//     and the agent's host tools (run the app, read its log, call it), answered by the page.
//   - It serves the studio's HTTP over MessagePorts: one for the page (admin and owner tokens),
//     one for the runner (a read-only token to build from).

import { serveHandlerOverPort } from "@statewalker/cellb";
import { type LoadedProject, loadProject } from "@statewalker/cellb/browser";
import type { FilesApi } from "@statewalker/webrun-files";
import { openSource } from "./sources";
import type { FromStudio, HostOut, HostTool, ToStudio } from "./studio-protocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FromStudio) => scope.postMessage(m);

const stores = new Map<string, FilesApi>();
let hostCallId = 0;
const hostCalls = new Map<number, (out: HostOut) => void>();

// The engines agents run on a copy of the project: Python (Pyodide) and Wasmer (WASIX), each a
// Worker of its own, started on first use. An engine's runs go one at a time: they share its
// workspace (a second run copying in other files would make the first one's diff report
// everything else as deleted), and a model may call tools in parallel. A run that does not end,
// or an engine that fails, costs the engine: it is replaced.
const ENGINE_TIMEOUT_MS = 150_000; // a first run downloads the engine (Pyodide ~10 MB, packages)
const failed = (error: string) => ({
  stdout: "",
  stderr: "",
  value: null,
  exitCode: null,
  error,
  changes: [],
});
// The factory, not a URL: Vite bundles a worker only from `new Worker(new URL(…), …)` written out.
function engine(start: () => Worker) {
  let worker: Worker | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let nextId = 0;
  const runOne = (req: object) => {
    worker ??= start();
    const w = worker;
    const id = ++nextId;
    return new Promise((resolve) => {
      const done = (out: unknown, replace: boolean) => {
        clearTimeout(timer);
        w.removeEventListener("message", onMessage);
        w.removeEventListener("error", onError);
        if (replace) {
          if (worker === w) worker = undefined;
          w.terminate();
        }
        resolve(out);
      };
      const onMessage = (e: MessageEvent<{ id: number }>) => {
        if (e.data?.id === id) done(e.data, false);
      };
      const onError = (e: ErrorEvent) => done(failed(`the engine failed: ${e.message}`), true);
      const timer = setTimeout(
        () => done(failed(`ETIMEDOUT: the run took over ${ENGINE_TIMEOUT_MS / 1000} s`), true),
        ENGINE_TIMEOUT_MS,
      );
      w.addEventListener("message", onMessage);
      w.addEventListener("error", onError);
      w.postMessage({ id, ...req });
    });
  };
  return (req: object) => {
    const run = queue.then(() => runOne(req));
    queue = run.catch(() => {});
    return run;
  };
}
const python = engine(
  () => new Worker(new URL("./python.worker.ts", import.meta.url), { type: "module" }),
);
const wasmer = engine(
  () => new Worker(new URL("./wasmer.worker.ts", import.meta.url), { type: "module" }),
);

(globalThis as { cellbStudioHost?: unknown }).cellbStudioHost = {
  python,
  wasmer,
  store: (ws: string) => stores.get(ws),
  notify: (ws: string, path: string, kind: "write" | "delete" | "mkdir") =>
    post({ type: "changed", ws, path, kind }),
  call(tool: HostTool, args: Record<string, unknown>) {
    const id = ++hostCallId;
    return new Promise<HostOut>((resolve) => {
      hostCalls.set(id, resolve);
      post({ type: "host-call", id, tool, args });
    });
  },
};

const POOL_PREFIX = "cellb-sandbox-studio-t";

async function sweepPools() {
  console.info("[studio] sweeping the pools of tabs gone");
  try {
    const root = (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle & {
      keys(): AsyncIterable<string>;
    };
    const names: string[] = [];
    for await (const name of root.keys()) if (name.includes(POOL_PREFIX)) names.push(name);
    for (const name of names) await root.removeEntry(name, { recursive: true }).catch(() => {});
  } catch {
    // No OPFS here, or nothing to sweep.
  }
}

let studioUrl: string | undefined;
let studio: Promise<LoadedProject> | undefined;
function openStudio(): Promise<LoadedProject> {
  if (!studioUrl) return Promise.reject(new Error("the studio worker was not initialized"));
  const url = studioUrl;
  // Its cells keep their state (sessions, conversations) in OPFS. That state belongs to this
  // tab's openings (a workspace is made per opening), and a pool another tab holds cannot be
  // opened: so each tab has a pool of its own, and pools of tabs gone are swept first (a pool a
  // live tab holds cannot be removed, and is left alone).
  studio ??= sweepPools()
    .then(() => {
      console.info("[studio] pools swept; starting the studio's cells");
      return loadProject(new URL(url), {
        data: `${POOL_PREFIX}${crypto.randomUUID().slice(0, 8)}`,
      });
    })
    .then((project) => {
      console.info("[studio] started");
      return project;
    })
    .catch((err) => {
      studio = undefined;
      throw err;
    });
  return studio;
}

async function handle(request: Request): Promise<Response> {
  try {
    return await (await openStudio()).fetch(request);
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}

function fsOnly(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && pathname.startsWith("/api/fs/")) return handle(request);
  return Promise.resolve(
    new Response(JSON.stringify({ error: "this port reaches the files API only" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }),
  );
}

scope.addEventListener("message", (e: MessageEvent<ToStudio>) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object" || !("type" in msg)) return;
  if (msg.type === "init") {
    studioUrl = msg.studioUrl;
    void openStudio().catch((err) => post({ type: "log", text: `studio: ${err}`, level: "error" }));
  } else if (msg.type === "mount") {
    openSource(msg.source).then(
      (fs) => {
        stores.set(msg.ws, fs);
        post({ type: "mounted", id: msg.id });
      },
      (err) => post({ type: "mounted", id: msg.id, error: String((err as Error)?.message ?? err) }),
    );
  } else if (msg.type === "unmount") {
    stores.delete(msg.ws);
  } else if (msg.type === "connect") {
    // The runner's port: the app's own server code runs in the runner's realm, so this port
    // reaches the files API alone (a token is still needed there), never the admin routes.
    void serveHandlerOverPort(msg.port, msg.scope === "fs" ? fsOnly : handle);
  } else if (msg.type === "host-reply") {
    hostCalls.get(msg.id)?.(msg.out);
    hostCalls.delete(msg.id);
  }
});
