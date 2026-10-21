/**
 * Records golden transcripts from the REAL celld (`celld dev`) for every scenario:
 *   CELLD_BIN=/path/to/celld ESBUILD_DIR=/dir/with/esbuild npx tsx conformance/record-celld.ts [name...]
 * Each example runs in a fresh copy (fresh .celld state).
 */
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runScenario, scenarios, type Target } from "./scenarios.ts";

const celld = process.env.CELLD_BIN ?? "celld";
const here = import.meta.dirname;
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenarios);
let port = 18_700;

for (const name of names) {
  const dir = join(mkdtempSync(join(tmpdir(), `celld-${name}-`)), name);
  cpSync(resolve(here, "celld-examples", name), dir, { recursive: true });
  const p = ++port;
  const env = { ...process.env, PATH: `${process.env.ESBUILD_DIR ?? ""}:${process.env.PATH}` };
  const proc = spawn(celld, ["dev", ".", "--port", String(p)], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  const origin = `http://127.0.0.1:${p}`;
  const t0 = Date.now();
  while (!log.includes("ready")) {
    if (Date.now() - t0 > 30_000 || proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!log.includes("ready")) {
    console.log(`✗ ${name}: celld did not start\n${log.slice(-800)}`);
    proc.kill();
    continue;
  }
  const target: Target = {
    origin,
    fetch: (req) => fetch(req),
    websocket: (url) =>
      new Promise((resolveWs, reject) => {
        const ws = new WebSocket(url);
        const queue: unknown[] = [];
        const waiters: ((v: unknown) => void)[] = [];
        ws.onmessage = (e) => (waiters.length ? waiters.shift()!(e.data) : queue.push(e.data));
        ws.onerror = () => reject(new Error("websocket error"));
        ws.onopen = () =>
          resolveWs({
            send: (m) => ws.send(m),
            next: () =>
              queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)),
            close: () => ws.close(),
          });
      }),
  };
  try {
    const transcript = await runScenario(target, scenarios[name]);
    writeFileSync(
      resolve(here, "golden", `${name}.json`),
      `${JSON.stringify({ celld: "0.6.2", transcript }, null, 2)}\n`,
    );
    console.log(`✓ ${name}: ${transcript.length} exchanges`);
  } catch (e) {
    console.log(`✗ ${name}: ${(e as Error).message}`);
  } finally {
    proc.kill();
  }
}
process.exit(0);
