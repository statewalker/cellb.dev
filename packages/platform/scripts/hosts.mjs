// Starts a wrangler project (a folder with wrangler.json or wrangler.jsonc) on one of the hosts
// the platform targets, and stops it:
//
//   wrangler   `wrangler dev` (workerd, as on Cloudflare)
//   celld      `celld dev` (celld 0.6.3; CELLD_BIN, else ~/.cache/celld/celld: scripts/get-celld.sh)
//   cellb      cellb in Node (scripts/serve-cellb.mjs, through tsx: in this repository cellb's
//              entry points are its TypeScript sources)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
export const HOSTS = ["wrangler", "celld", "cellb"];
const tsxCli = createRequire(join(root, "package.json")).resolve("tsx/cli");

export function celldBin() {
  const bin = process.env.CELLD_BIN ?? join(process.env.HOME, ".cache/celld/celld");
  if (!existsSync(bin))
    throw new Error(`celld not found at ${bin}: run scripts/get-celld.sh or set CELLD_BIN`);
  return bin;
}

function configOf(dir) {
  for (const n of ["wrangler.json", "wrangler.jsonc"])
    if (existsSync(join(dir, n))) return join(dir, n);
  throw new Error(`no wrangler.json(c) in ${dir}`);
}

async function waitReady(url, child, logs, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null)
      throw new Error(`host exited (${child.exitCode}):\n${logs.join("")}`);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await r.body?.cancel();
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`host not ready at ${url} after ${timeoutMs} ms:\n${logs.join("").slice(-4000)}`);
}

/** Starts `dir` on `host`; resolves when it answers HTTP. */
export async function startHost(host, dir, { port, quiet = true, timeoutMs = 120_000 } = {}) {
  dir = resolve(dir);
  port ??= 20000 + Math.floor(Math.random() * 20000);
  const state = mkdtempSync(join(tmpdir(), `webrun-${host}-`));
  const bin = join(root, "node_modules/.bin");
  const env = { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}` };
  let child;
  if (host === "wrangler") {
    child = spawn(
      join(bin, "wrangler"),
      [
        "dev",
        "-c",
        configOf(dir),
        "--port",
        String(port),
        "--ip",
        "127.0.0.1",
        "--persist-to",
        state,
        "--show-interactive-dev-session=false",
      ],
      { env, cwd: dir },
    );
  } else if (host === "celld") {
    rmSync(join(dir, ".celld"), { recursive: true, force: true });
    child = spawn(celldBin(), ["dev", ".", "--port", String(port)], { env, cwd: dir });
  } else if (host === "cellb") {
    child = spawn(
      process.execPath,
      [tsxCli, join(root, "scripts/serve-cellb.mjs"), dir, "--port", String(port), "--data", state],
      { env, cwd: dir },
    );
  } else throw new Error(`unknown host ${host}`);
  const logs = [];
  const sink = (d) => {
    logs.push(d.toString());
    if (!quiet) process.stderr.write(d);
  };
  child.stdout.on("data", sink);
  child.stderr.on("data", sink);
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitReady(url, child, logs, timeoutMs);
  } catch (e) {
    child.kill("SIGKILL");
    throw e;
  }
  return {
    host,
    url,
    logs,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((r) => {
          const t = setTimeout(() => {
            child.kill("SIGKILL");
            r();
          }, 5000);
          child.on("exit", () => {
            clearTimeout(t);
            r();
          });
        });
      }
      rmSync(state, { recursive: true, force: true });
      if (host === "celld") rmSync(join(dir, ".celld"), { recursive: true, force: true });
    },
  };
}
