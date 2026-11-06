/// <reference lib="webworker" />
// The partyserver host project (test/partyserver) on cellb in a Dedicated Worker: SQLite on
// OPFS, loaded Workers in isolates of their own (isolate-worker), and a fleet log in OPFS so a
// restarted runtime restores the room and the extension's facet from it.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import isolateWorker from "@statewalker/cellb/isolate-worker?worker&url";
import { browserProjectRuntime } from "../../../src/browser.js";
import { createWebSocketClass, type WranglerConfig } from "../../../src/index.js";

type Op =
  | { op: "start"; config: WranglerConfig; bundle: string; run: string }
  | { op: "fetch"; path: string }
  | { op: "socket"; path: string; send: string[]; receive: number }
  | { op: "restart" };

let host: Awaited<ReturnType<typeof browserProjectRuntime>> | undefined;
let started: Extract<Op, { op: "start" }> | undefined;
let generation = 0;
const sqlite3 = (sqlite3InitModule as any)({ print() {}, printErr() {} });

const start = async (s: Extract<Op, { op: "start" }>) => {
  generation++;
  host = await browserProjectRuntime({
    config: s.config,
    code: { bundle: s.bundle },
    isolateScript: new URL(isolateWorker, import.meta.url),
    sqlite3: await sqlite3,
    // A restarted runtime is a fresh node: a pool of its own, its state from the log.
    pool: `party-${s.run}-${generation}`,
    filesDir: `party-files-${s.run}`,
    bucket: { opfs: `party-log-${s.run}`, node: `node-${generation}`, leaseTtlMs: 1_000 },
  });
};

const socket = (path: string, send: string[], receive: number) =>
  new Promise<string[]>((resolve, reject) => {
    const runtime = host!.runtime;
    const WS = createWebSocketClass((url, p) => runtime.connectWebSocket(url, p));
    const ws = new WS(`ws://party${path}`);
    const inbox: string[] = [];
    const timer = setTimeout(() => (ws.close(), resolve(inbox)), 10_000);
    ws.onmessage = (e: MessageEvent) => {
      inbox.push(String(e.data));
      if (inbox.length === receive) {
        clearTimeout(timer);
        ws.close();
        resolve(inbox);
      }
    };
    ws.onerror = () => reject(new Error(`socket ${path} failed`));
    ws.onopen = () => {
      for (const m of send) ws.send(m);
    };
  });

self.onmessage = async (e: MessageEvent<Op>) => {
  const reply = (v: unknown) => (e.ports[0] as MessagePort).postMessage(v);
  const m = e.data;
  try {
    if (m.op === "start") {
      started = m;
      await start(m);
      return reply({ ok: true, unsupported: host!.unsupported });
    }
    if (m.op === "fetch") {
      const res = await host!.runtime.fetch(new Request(`http://party${m.path}`));
      return reply({ ok: true, status: res.status, text: await res.text() });
    }
    if (m.op === "socket")
      return reply({ ok: true, inbox: await socket(m.path, m.send, m.receive) });
    if (m.op === "restart") {
      await host!.close();
      // The first node's lease must lapse before the next one takes the cells.
      await new Promise((r) => setTimeout(r, 1_500));
      await start(started!);
      return reply({ ok: true });
    }
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
