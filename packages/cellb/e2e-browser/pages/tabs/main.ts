// A tab of a project shared by every tab of the origin: it takes its share of the shards
// (joinProjectShards) and sends requests through the ServiceWorker's router.
import {
  joinProjectShards,
  type ProjectTabs,
  serviceWorkerConnector,
} from "../../../src/browser.js";
import { createWebSocketClass, type WranglerConfig } from "../../../src/index.js";

async function serviceWorker(): Promise<ServiceWorker> {
  // The page's query, when it carries router options (sw.ts), goes to the ServiceWorker's URL.
  const options = new URLSearchParams(location.search);
  const swUrl = new URL("./sw.ts", import.meta.url);
  for (const key of ["strip", "root", "host", "wait"])
    if (options.has(key)) swUrl.searchParams.set(key, options.get(key) ?? "");
  // Vite takes a URL ending in ".html", query included (`host=/tabs/host.html`), for a page.
  if (swUrl.search) swUrl.searchParams.set("sw", "1");
  await navigator.serviceWorker.register(swUrl, {
    type: "module",
    scope: "./",
  });
  const reg = await navigator.serviceWorker.ready;
  // Requests must go through it: wait until it controls this page (clients.claim()).
  if (!navigator.serviceWorker.controller)
    await new Promise((r) =>
      navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }),
    );
  return reg.active!;
}

let tabs: ProjectTabs | undefined;
let name = "";
Object.assign(window, {
  /** Joins the project: this tab runs its share of `shards` shards. */
  __join: async (job: { name: string; shards: number; config: WranglerConfig; code: string }) => {
    name = job.name;
    tabs = await joinProjectShards({
      name: job.name,
      shards: job.shards,
      spawn: () => new Worker(new URL("./shard-worker.ts", import.meta.url), { type: "module" }),
      config: job.config,
      code: { bundle: job.code },
      serviceWorker,
      onChange: (owned) => (document.body.dataset.owned = owned.join(",")),
      checkMs: 300,
    });
    return true;
  },
  /** A request to the project's Worker, through the ServiceWorker. */
  __fetch: async (path: string) => {
    const res = await fetch(`/tabs/app/${name}${path}`);
    return { status: res.status, body: await res.text() };
  },
  __leave: () => tabs?.close(),
  /** Joins one more project (`__join` keeps the first): two projects on one ServiceWorker. */
  __joinAnother: async (job: {
    name: string;
    shards: number;
    config: WranglerConfig;
    code: string;
  }) => {
    others.push(
      await joinProjectShards({
        name: job.name,
        shards: job.shards,
        spawn: () => new Worker(new URL("./shard-worker.ts", import.meta.url), { type: "module" }),
        config: job.config,
        code: { bundle: job.code },
        serviceWorker,
        checkMs: 300,
      }),
    );
    return true;
  },
  /** A request to project `project` (default: the joined one), with its init. */
  __request: async (path: string, init: RequestInit = {}, project = name) => {
    // A path from the origin's root (`/tabs/…`) as it is; else under the project's base.
    const res = await fetch(path.startsWith("/tabs/") ? path : `/tabs/app/${project}${path}`, init);
    return { status: res.status, body: await res.text() };
  },
  /**
   * A socket to the project through the ServiceWorker: sends `message`, returns the first reply.
   * `headers`: what the page asks the ServiceWorker to put on the upgrade (a forged one, say).
   */
  __socket: async (
    path: string,
    message: string,
    project = name,
    headers?: [string, string][],
    via: "cellb" | "package" = "cellb",
  ) => {
    type Answer = { ok: boolean; port?: MessagePort; protocol?: string; error?: string };
    const WS = createWebSocketClass(
      headers && via === "package"
        ? // webrun-http-browser's own socket call, which the dispatcher answers for any page of
          // the origin, with the header names exactly as given.
          async (url, protocols) => {
            const { port1, port2 } = new MessageChannel();
            const answer = new Promise<{
              result?: { port: MessagePort; protocol?: string };
              error?: unknown;
            }>((r) => (port1.onmessage = (e) => r(e.data)));
            navigator.serviceWorker.controller?.postMessage(
              { type: "webrun-http:ws-connect", params: { url, protocols, headers } },
              [port2],
            );
            const { result, error } = await answer;
            if (error || !result) throw new Error(String((error as Error)?.message ?? error));
            return { port: result.port, protocol: result.protocol ?? "" };
          }
        : headers
          ? async (url, protocols) => {
              const { port1, port2 } = new MessageChannel();
              const answer = new Promise<Answer>((r) => (port1.onmessage = (e) => r(e.data)));
              navigator.serviceWorker.controller?.postMessage(
                { type: "cells-ws", url, protocols, headers },
                [port2],
              );
              const a = await answer;
              if (!a.ok || !a.port) throw new Error(a.error ?? "refused");
              return { port: a.port, protocol: a.protocol ?? "" };
            }
          : serviceWorkerConnector(),
    );
    const ws = new WS(
      new URL(`/tabs/app/${project}${path}`, location.href).href.replace(/^http/, "ws"),
    );
    const reply = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply in 20 s")), 20_000);
      const done = (settle: () => void) => (clearTimeout(timer), settle());
      ws.onopen = () => ws.send(message);
      ws.onmessage = (e) => done(() => resolve(String(e.data)));
      ws.onerror = () => done(() => reject(new Error("socket failed")));
      ws.onclose = (e) => done(() => reject(new Error(`closed ${e.code} before a reply`)));
    });
    ws.close();
    return reply;
  },
});
const others: ProjectTabs[] = [];

serviceWorker().then(
  () => (document.body.dataset.ready = "true"),
  (e) => (document.body.dataset.error = String(e?.stack ?? e)),
);
