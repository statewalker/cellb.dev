/// <reference lib="webworker" />
// The partyserver host project (test/partyserver) on cellb in a Dedicated Worker: SQLite on
// OPFS, loaded Workers in isolates of their own (isolate-worker), and a fleet log in OPFS so a
// restarted runtime restores the room and the extension's facet from it.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import isolateWorker from "@statewalker/cellb/isolate-worker?worker&url";
import { browserProjectRuntime } from "../../../src/browser.js";
import { createWebSocketClass, type WranglerConfig } from "../../../src/index.js";

type Op =
  | {
      op: "start";
      config: WranglerConfig;
      bundle: string;
      run: string;
      /** The bucket lease (ms); the default (10 s) unless a test needs another. */
      leaseTtlMs?: number;
    }
  | { op: "fetch"; path: string }
  | { op: "socket"; path: string; send: string[]; receive: number }
  | { op: "restart" }
  | { op: "bench"; path: string; sockets: number; sizes?: string[] };

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
    bucket: { opfs: `party-log-${s.run}`, node: `node-${generation}`, leaseTtlMs: s.leaseTtlMs },
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
    if (m.op === "bench")
      return reply({ ok: true, result: await bench(m.path, m.sockets, m.sizes) });
    if (m.op === "restart") {
      // A clean close removes the first node's lease record: the next one takes the cells at
      // once, with no lease to wait out.
      await host!.close();
      await start(started!);
      return reply({ ok: true });
    }
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};

/**
 * A socket's echo round trip, its throughput at three message sizes (back to back, until the
 * last echo), and how many sockets one isolate holds at once (socket.probe.spec.ts).
 */
async function bench(path: string, sockets: number, sizes = ["64B", "1KiB", "64KiB"]) {
  const runtime = host!.runtime;
  let connectError = "";
  const WS = createWebSocketClass(async (url, p) => {
    try {
      return await runtime.connectWebSocket(url, p);
    } catch (e) {
      connectError = String((e as Error)?.stack ?? e).slice(0, 600);
      throw e;
    }
  });
  const open = () =>
    new Promise<{ ws: InstanceType<typeof WS>; next(): Promise<string> }>((resolve, reject) => {
      const ws = new WS(`ws://party${path}`);
      const waiting: ((v: string) => void)[] = [];
      ws.onmessage = (e: MessageEvent) => waiting.shift()?.(String(e.data));
      ws.onerror = (e: Event) =>
        reject(new Error(`socket failed: ${(e as ErrorEvent).message ?? e.type}`));
      ws.onopen = () => resolve({ ws, next: () => new Promise<string>((r) => waiting.push(r)) });
    });
  const r: Record<string, number> = {};
  const s = await open();
  await s.next(); // the greeting
  for (let i = 0; i < 200; i++) {
    const n = s.next();
    s.ws.send("w");
    await n;
  }
  const rtts: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const n = s.next();
    const t = performance.now();
    s.ws.send("p");
    await n;
    rtts.push(performance.now() - t);
  }
  rtts.sort((a, b) => a - b);
  const q = (p: number) => rtts[Math.floor(p * (rtts.length - 1))];
  Object.assign(r, { rttP50Ms: q(0.5), rttP95Ms: q(0.95), rttP99Ms: q(0.99) });
  for (const [label, size, count] of [
    ["64B", 64, 20_000],
    ["1KiB", 1024, 20_000],
    ["64KiB", 65_536, 2_000],
  ] as const) {
    if (!sizes.includes(label)) continue;
    const msg = "x".repeat(size);
    let got = 0;
    const done = new Promise<void>((resolve) => {
      s.ws.onmessage = () => {
        if (++got === count) resolve();
      };
    });
    const t = performance.now();
    for (let i = 0; i < count; i++) s.ws.send(msg);
    await done;
    const sec = (performance.now() - t) / 1000;
    r[`msgsPerSec${label}`] = Math.round(count / sec);
    r[`mbPerSec${label}`] = Math.round(((count * size) / sec / 2 ** 20) * 10) / 10;
  }
  s.ws.close();
  const held: { ws: InstanceType<typeof WS> }[] = [];
  let failure = "";
  const t = performance.now();
  for (let i = 0; i < sockets; i++) {
    try {
      held.push(
        await Promise.race([
          open(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out")), 5_000)),
        ]),
      );
    } catch (err) {
      failure = `${String((err as Error)?.message ?? err)}: ${connectError.split("\n")[0]}`;
      break;
    }
  }
  r.concurrentSockets = held.length;
  r.concurrentOpenMs = Math.round(performance.now() - t);
  for (const c of held) c.ws.close();
  return { ...r, failure };
}
