// The "run" step of a build trace, in a plain Node process: evaluates traces/<app>/worker.js
// with the globals cellb's browser realm gives a bundle (Node's own modules stand in for the
// node:* polyfills) and requests a few paths without bindings. Appends traces/<app>/NN-run.json.
import { readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const app = process.argv[2] ?? "emdash";
const dir = join(import.meta.dirname, "../traces", app);
const require = createRequire(import.meta.url);
const events = [];
const t0 = performance.now();
const add = (what, data, ms) => {
  const e = {
    step: "run",
    t: Math.round(performance.now() - t0),
    what,
    ...(ms !== undefined ? { ms: Math.round(ms) } : {}),
    data,
  };
  events.push(e);
  console.log(
    `[${String(e.t).padStart(6)} ms] run ${what}${ms !== undefined ? ` (${e.ms} ms)` : ""} ${JSON.stringify(data ?? {}).slice(0, 300)}`,
  );
};
const g = globalThis;
g.__cellsNodeModules = new Proxy({}, { get: (_, k) => require(String(k)) });
g.__cellsWorkersModule = {
  DurableObject: class {},
  WorkerEntrypoint: class {},
  WorkflowEntrypoint: class {},
  RpcTarget: class {},
};
g.__cellsProjectScope = {
  env: { EMDASH_SITE_URL: "http://localhost" },
  exports: {},
  waitUntil() {},
};
let t = performance.now();
const mod = await import(pathToFileURL(join(dir, "worker.js")).href);
add("evaluate the Worker module", { exports: Object.keys(mod) }, performance.now() - t);
for (const path of process.argv.slice(3).length
  ? process.argv.slice(3)
  : ["/robots.txt", "/_emdash/api/setup/status", "/"]) {
  t = performance.now();
  try {
    const res = await mod.default.fetch(
      new Request(`http://localhost${path}`),
      {},
      { waitUntil() {} },
    );
    const body = await res.text();
    add(
      `GET ${path}`,
      {
        status: res.status,
        type: res.headers.get("content-type"),
        bytes: body.length,
        body: body.slice(0, 600),
      },
      performance.now() - t,
    );
  } catch (err) {
    add(
      `GET ${path} FAILED`,
      { error: String(err?.stack ?? err).slice(0, 1500) },
      performance.now() - t,
    );
  }
}
const n = readdirSync(dir).filter((f) => /^\d\d-/.test(f)).length + 1;
writeFileSync(join(dir, `${String(n).padStart(2, "0")}-run.json`), JSON.stringify(events, null, 1));
