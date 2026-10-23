/**
 * Records golden transcripts from the REAL celld (`celld dev`) for every scenario:
 *   CELLD_BIN=/path/to/celld ESBUILD_DIR=/dir/with/esbuild npx tsx conformance/record-celld.ts [name...]
 * Each example runs in a fresh copy (fresh .celld state).
 */
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startReferenceServer } from "../test/ws-reference-server.ts";
import { httpTarget } from "./http-target.ts";
import { projectDir } from "./projects.ts";
import { normalizeLogs, runScenario, scenarios } from "./scenarios.ts";

const celld = process.env.CELLD_BIN ?? "celld";
const here = import.meta.dirname;
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenarios);
let port = 18_700;

for (const name of names) {
  const dir = join(mkdtempSync(join(tmpdir(), `celld-${name}-`)), name);
  cpSync(projectDir(name), dir, { recursive: true });
  const p = ++port;
  const env = { ...process.env, PATH: `${process.env.ESBUILD_DIR ?? ""}:${process.env.PATH}` };
  const ref = scenarios[name].wsServer ? await startReferenceServer() : undefined;
  const proc = spawn(celld, ["dev", ".", "--port", String(p), "--logs"], {
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
  const target = httpTarget(origin, ref ? `ws://127.0.0.1:${ref.port}` : undefined);
  try {
    const scenario = scenarios[name];
    const from = log.length;
    const transcript = await runScenario(target, scenario);
    let logs: string[] | undefined;
    if (scenario.logs) {
      await new Promise((r) => setTimeout(r, scenario.settleMs ?? 1500));
      logs = normalizeLogs(
        [...log.slice(from).matchAll(/cell_console: (.*)$/gm)].map((m) => m[1]),
        scenario,
      );
    }
    writeFileSync(
      resolve(here, "golden", `${name}.json`),
      `${JSON.stringify({ celld: "0.6.2", transcript, ...(logs ? { logs } : {}) }, null, 2)}\n`,
    );
    console.log(
      `✓ ${name}: ${transcript.length} exchanges${logs ? `, ${logs.length} log lines` : ""}`,
    );
  } catch (e) {
    console.log(`✗ ${name}: ${(e as Error).message}`);
  } finally {
    proc.kill();
    await ref?.close();
  }
}
process.exit(0);
