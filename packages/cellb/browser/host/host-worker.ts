/// <reference lib="webworker" />
// The host app's worker: runs one project long-lived (browser-host.ts) on SQLite WASM in OPFS,
// optionally on a celld fleet bucket, and answers HTTP requests the page forwards to it.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { cellsCaches } from "../../src/bindings/cache.js";
import { browserIsolatedLoader } from "../../src/isolate/browser.js";
import { installNodeGlobals } from "../../src/node-compat/install.js";
import { type BrowserBucket, browserProjectRuntime } from "../../src/project/browser-host.js";
import * as workersModule from "../../src/project/cloudflare-workers.js";
import { siteModuleLoader, workersHostRegistry } from "../../src/project/site.js";
import type { WranglerConfig } from "../../src/project/wrangler.js";
import {
  CellsResponse,
  HTMLRewriter,
  WebSocketPair,
  WebSocketRequestResponsePair,
} from "../../src/ws/server.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let host: Awaited<ReturnType<typeof browserProjectRuntime>> | undefined;
let nodeName = "";

type Msg =
  | {
      type: "start";
      name: string;
      baseUrl: string;
      config: WranglerConfig;
      assets: [string, string][];
      bucket?: BrowserBucket;
      pool: string;
    }
  | {
      type: "fetch";
      url: string;
      method: string;
      headers: [string, string][];
      body: ArrayBuffer | null;
    }
  | { type: "owned" }
  | { type: "stop" };

scope.onmessage = async (e) => {
  const reply = (v: unknown, transfer: Transferable[] = []) =>
    (e.ports[0] as MessagePort).postMessage(v, transfer);
  const m = e.data as Msg;
  try {
    if (m.type === "start") {
      nodeName = m.bucket?.node ?? "";
      const nodeCompat = (m.config.compatibility_flags ?? []).some((f) =>
        f.startsWith("nodejs_compat"),
      );
      if (nodeCompat) installNodeGlobals();
      workersHostRegistry({
        workersModule,
        Response: CellsResponse,
        WebSocketPair,
        caches: cellsCaches,
        HTMLRewriter,
        WebSocketRequestResponsePair,
        node: nodeCompat
          ? (await import("../../src/node-compat/browser-registry.js")).nodeRegistryEntries
          : undefined,
      });
      const module = m.config.main
        ? await import(/* @vite-ignore */ `${m.baseUrl}modules/~/${m.config.main}`)
        : { default: {} };
      const sqlite3 = await (sqlite3InitModule as any)({ print() {}, printErr() {} });
      host = await browserProjectRuntime({
        config: m.config,
        module,
        sqlite3,
        pool: m.pool,
        filesDir: `${m.pool}-files`,
        assetFiles: new Map(
          m.assets.map(
            ([p, b64]) => [p, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))] as const,
          ),
        ),
        loadModules: siteModuleLoader(m.baseUrl),
        isolatedModules: browserIsolatedLoader({
          isolateScript: new URL("../isolate/isolate-worker.ts", import.meta.url),
          siteBaseUrl: m.baseUrl,
          storagePrefix: `${m.pool}-iso`,
        }),
        bucket: m.bucket,
      });
      return reply({ ok: true, unsupported: host.unsupported });
    }
    if (m.type === "fetch") {
      if (!host)
        return reply({
          status: 503,
          headers: [],
          body: new TextEncoder().encode("not started").buffer,
        });
      const r = await host.runtime.fetch(
        new Request(m.url, { method: m.method, headers: m.headers, body: m.body }),
      );
      const body = await r.arrayBuffer();
      return reply({ status: r.status, statusText: r.statusText, headers: [...r.headers], body }, [
        body,
      ]);
    }
    if (m.type === "owned") {
      // the cells this node owns in the fleet bucket (own.json naming this node)
      const store = host?.bucket?.store;
      if (!store) return reply({ owned: [] });
      const owned: string[] = [];
      for (const key of await store.list("cells/"))
        if (key.endsWith("/own.json")) {
          const o = await store.get(key);
          const rec = o && JSON.parse(new TextDecoder().decode(o.body));
          if (rec?.node === nodeName) owned.push(key.slice(6, -9));
        }
      return reply({ owned });
    }
    if (m.type === "stop") {
      await host?.close();
      host = undefined;
      return reply({ ok: true });
    }
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
