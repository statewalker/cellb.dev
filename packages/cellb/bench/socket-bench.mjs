#!/usr/bin/env node
// WebSockets into a loaded Worker's isolate (Worker Loader), on Node, from the built package:
// the partyserver extension of test/partyserver, run as a facet in its isolate.
//
//   pnpm build && node bench/socket-bench.mjs            # 3 runs, each in a child process
//   BENCH_JSON=out.json node bench/socket-bench.mjs      # also write the results
//
// Measures a socket's echo round trip, its throughput at three message sizes (messages sent
// back to back, until the last echo arrives), and how many sockets one isolate holds at once.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const pkg = new URL("..", import.meta.url).pathname;
const fixture = join(pkg, "test/partyserver");
const RUNS = Number(process.env.RUNS ?? 3);

if (process.argv[2] === "--child") await child();
else await parent();

async function parent() {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const out = execFileSync(process.execPath, [SELF, "--child"], {
      encoding: "utf8",
      maxBuffer: 1 << 26,
    });
    runs.push(JSON.parse(out.trim().split("\n").at(-1)));
    process.stderr.write(`run ${i + 1}/${RUNS} done\n`);
  }
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const keys = Object.keys(runs[0]);
  const result = {
    date: new Date().toISOString().slice(0, 10),
    machine: {
      cpus: os.cpus().length,
      cpu: os.cpus()[0]?.model,
      memoryGB: Math.round(os.totalmem() / 2 ** 30),
      node: process.version,
    },
    runs: RUNS,
    median: Object.fromEntries(keys.map((k) => [k, median(runs.map((r) => r[k]))])),
    all: runs,
  };
  console.log(JSON.stringify(result, null, 2));
  if (process.env.BENCH_JSON)
    writeFileSync(process.env.BENCH_JSON, `${JSON.stringify(result, null, 2)}\n`);
}

async function child() {
  const { build } = await import("esbuild");
  const { loadNodeProject, nodeSqliteOpener } = await import(join(pkg, "dist/node.js"));
  const { createWebSocketClass, filesApiLtxLog } = await import(join(pkg, "dist/index.js"));
  const { MemFilesApi } = await import("@statewalker/webrun-files-mem");
  const plugin = (
    await build({
      entryPoints: [join(fixture, "plugin.js")],
      bundle: true,
      format: "esm",
      platform: "browser",
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:workers"],
      write: false,
      logLevel: "silent",
    })
  ).outputFiles[0].text;
  const text = (await import("node:fs")).readFileSync(join(fixture, "wrangler.jsonc"), "utf8");
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
  const dir = mkdtempSync(join(os.tmpdir(), "socket-bench-"));
  writeFileSync(
    join(dir, "wrangler.json"),
    JSON.stringify({ ...config, main: join(fixture, "index.js"), vars: { PLUGIN_CODE: plugin } }),
  );
  const { runtime } = await loadNodeProject(dir, {
    openSql: nodeSqliteOpener(mkdtempSync(join(os.tmpdir(), "socket-bench-sql-"))),
    files: new MemFilesApi(),
    storage: filesApiLtxLog(new MemFilesApi(), { epoch: 1 }),
  });
  const WS = createWebSocketClass((url, p) => runtime.connectWebSocket(url, p));
  const open = (path) =>
    new Promise((resolve, reject) => {
      const ws = new WS(`ws://bench${path}`);
      const waiting = [];
      ws.onmessage = (e) => waiting.shift()?.(String(e.data));
      ws.onerror = () => reject(new Error("socket failed"));
      ws.onopen = () => resolve({ ws, next: () => new Promise((r) => waiting.push(r)) });
    });
  const r = {};
  const s = await open("/ext/notes");
  await s.next(); // the greeting
  // Warm up, then the round trip.
  for (let i = 0; i < 200; i++) {
    const n = s.next();
    s.ws.send("w");
    await n;
  }
  const rtts = [];
  for (let i = 0; i < 2000; i++) {
    const n = s.next();
    const t = performance.now();
    s.ws.send("p");
    await n;
    rtts.push(performance.now() - t);
  }
  rtts.sort((a, b) => a - b);
  const q = (p) => rtts[Math.floor(p * (rtts.length - 1))];
  Object.assign(r, { rttP50Ms: q(0.5), rttP95Ms: q(0.95), rttP99Ms: q(0.99) });
  // Throughput: count messages, back to back, until the last echo.
  for (const [label, size, count] of [
    ["64B", 64, 20_000],
    ["1KiB", 1024, 20_000],
    ["64KiB", 65_536, 2_000],
  ]) {
    const msg = "x".repeat(size);
    let got = 0;
    const done = new Promise((resolve) => {
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
  // Concurrent sockets into one isolate.
  const held = [];
  let failed = "";
  const t = performance.now();
  for (let i = 0; i < 1500; i++) {
    try {
      const c = await Promise.race([
        open("/ext/notes"),
        new Promise((_, rej) => setTimeout(() => rej(new Error("open timed out")), 5_000)),
      ]);
      held.push(c);
    } catch (e) {
      failed = String(e?.message ?? e);
      break;
    }
  }
  r.concurrentSockets = held.length;
  r.concurrentOpenMs = Math.round(performance.now() - t);
  r.concurrentFailure = failed ? 1 : 0;
  for (const c of held) c.ws.close();
  await runtime.close();
  console.log(JSON.stringify(r));
  process.exit(0);
}
