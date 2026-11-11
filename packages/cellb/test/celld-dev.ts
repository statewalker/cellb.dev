import { type ChildProcess, spawn } from "node:child_process";
import { freePort } from "./free-port.js";

export type CelldDev = { p: ChildProcess; port: number; base: string; log: () => string };

/**
 * Starts `celld dev .` in `dir` on a free port and waits until THIS process serves that port.
 *
 * `until`: "ready" waits for celld's `ready  http://127.0.0.1:<port>` line; "listening" for
 * `celld listening on 127.0.0.1:<port>` (a node that refuses a cell never becomes ready).
 *
 * The lines are matched with the port in them on purpose: a celld that cannot bind its port
 * logs "Address alREADY in use" and exits, and a bare `includes("ready")` took that for
 * readiness — the test then talked to whichever process owned the port (another test file's
 * celld, running in parallel), incrementing that one's counters. `freePort` only knows the
 * port was free a moment ago (another worker, or a celld's own ephemeral internal listener,
 * can take it before this celld binds), so a bind failure is retried on a new port.
 */
export async function startCelldDev(
  dir: string,
  { until = "ready" }: { until?: "ready" | "listening" } = {},
): Promise<CelldDev> {
  const env = { ...process.env, PATH: `${process.env.ESBUILD_DIR ?? ""}:${process.env.PATH}` };
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await freePort();
    const marker =
      until === "ready"
        ? new RegExp(`\\bready\\s+http://127\\.0\\.0\\.1:${port}\\b`)
        : new RegExp(`celld listening on 127\\.0\\.0\\.1:${port}\\b`);
    const p = spawn(process.env.CELLD_BIN!, ["dev", ".", "--port", String(port), "--logs"], {
      cwd: dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    p.stdout!.on("data", (d) => (log += d));
    p.stderr!.on("data", (d) => (log += d));
    const closed = new Promise((r) => p.once("close", r)); // its output fully read
    const exited = () => p.exitCode !== null || p.signalCode !== null;
    for (let i = 0; i < 150 && !marker.test(log) && !exited(); i++)
      await new Promise((r) => setTimeout(r, 200));
    if (marker.test(log)) return { p, port, base: `http://127.0.0.1:${port}`, log: () => log };
    if (!exited()) p.kill("SIGKILL");
    await Promise.race([closed, new Promise((r) => setTimeout(r, 2000))]);
    last = log;
    if (!/address already in use/i.test(log)) break; // not a lost port race: report it
  }
  throw new Error(`celld dev did not start:\n${last.slice(-2500)}`);
}
