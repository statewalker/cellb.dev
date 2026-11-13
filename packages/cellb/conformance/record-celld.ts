/**
 * Records golden transcripts from the REAL celld (`celld dev`) for every scenario:
 *   CELLD_BIN=/path/to/celld ESBUILD_DIR=/dir/with/esbuild npx tsx conformance/record-celld.ts [name...]
 * Each example runs in a fresh copy (fresh .celld state).
 */
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type CelldDev, startCelldDev } from "../test/celld-dev.ts";
import { startReferenceServer } from "../test/ws-reference-server.ts";
import { httpTarget } from "./http-target.ts";
import { projectDir } from "./projects.ts";
import { normalizeLogs, runScenario, scenarios } from "./scenarios.ts";

const celld = process.env.CELLD_BIN ?? "celld";
process.env.CELLD_BIN = celld; // startCelldDev runs this binary
/** The version the goldens are recorded with ("celld 0.6.3" → "0.6.3"). */
const celldVersion = (await import("node:child_process"))
  .execFileSync(celld, ["--version"])
  .toString()
  .trim()
  .split(/\s+/)
  .pop();
const here = import.meta.dirname;
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenarios);

for (const name of names) {
  const dir = join(mkdtempSync(join(tmpdir(), `celld-${name}-`)), name);
  cpSync(projectDir(name), dir, { recursive: true });
  const ref = scenarios[name].wsServer ? await startReferenceServer() : undefined;
  // Waits for THIS celld's own ready line (a bare "ready" also matched "Address already in use",
  // and the goldens would then have been recorded from whichever celld held the port).
  let celldDev: CelldDev;
  try {
    celldDev = await startCelldDev(dir);
  } catch (e) {
    console.log(`✗ ${name}: ${(e as Error).message.slice(-800)}`);
    await ref?.close();
    continue;
  }
  const { p: proc, base: origin, log } = celldDev;
  const target = httpTarget(origin, ref ? `ws://127.0.0.1:${ref.port}` : undefined);
  try {
    const scenario = scenarios[name];
    const from = log().length;
    const transcript = await runScenario(target, scenario);
    let logs: string[] | undefined;
    if (scenario.logs) {
      await new Promise((r) => setTimeout(r, scenario.settleMs ?? 1500));
      logs = normalizeLogs(
        [
          ...log()
            .slice(from)
            .matchAll(/cell_console: (.*)$/gm),
        ].map((m) => m[1]),
        scenario,
      );
    }
    writeFileSync(
      resolve(here, "golden", `${name}.json`),
      `${JSON.stringify({ celld: celldVersion, transcript, ...(logs ? { logs } : {}) }, null, 2)}\n`,
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
