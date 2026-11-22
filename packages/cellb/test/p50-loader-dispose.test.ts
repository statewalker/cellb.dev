// Loaded Workers end with their handle (statewalker/cellb.dev#206): `dispose()` of what
// `env.LOADER.load()` or `env.LOADER.get()` returned ends its isolate, a worker thread on Node,
// as workerd does. Before, every load() left a thread for the life of the runtime, and a Worker
// that never yields could not be stopped.
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterEach, describe, expect, it } from "vitest";
import { loadNodeProject, nodeSqliteOpener } from "../src/node.js";

const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.close();
});

const MAIN = `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  ping() { return "pong"; }
  spin() { for (;;) {} }
}`;

/** A project whose Worker runs `body` with `code()`, the loaded Worker's code, in scope. */
async function project(body: string, main = MAIN) {
  const dir = mkdtempSync(join(tmpdir(), "cellb-dispose-"));
  writeFileSync(
    join(dir, "wrangler.jsonc"),
    JSON.stringify({
      name: "w",
      main: "index.js",
      compatibility_date: "2026-01-01",
      worker_loaders: [{ binding: "LOADER" }],
    }),
  );
  writeFileSync(
    join(dir, "index.js"),
    `const code = () => ({ compatibilityDate: "2026-01-01", mainModule: "main.js",
  modules: { "main.js": ${JSON.stringify(main)} } });
export default { async fetch(request, env) {
  try { ${body} } catch (e) { return Response.json({ error: String(e?.message ?? e) }); }
} };`,
  );
  const { runtime } = await loadNodeProject(dir, {
    openSql: nodeSqliteOpener(),
    files: new MemFilesApi(),
  });
  running.push(runtime);
  return runtime;
}

const json = async (runtime: { fetch(r: Request): Promise<Response> }, path = "/") =>
  (await runtime.fetch(new Request(`http://w${path}`))).json();

/** This process's OS threads: each worker thread adds several. */
const threads = () => readdirSync("/proc/self/task").length;
/** Waits until the thread count is at most `n` (terminated threads take a moment to go). */
async function threadsDownTo(n: number, ms = 5_000) {
  const end = Date.now() + ms;
  while (threads() > n && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return threads();
}

describe.skipIf(!existsSync("/proc/self/task"))("P50 dispose() of a loaded Worker", () => {
  it("load() then dispose(): no worker thread is left behind", async () => {
    const runtime = await project(`
const out = [];
for (let i = 0; i < 8; i++) {
  const w = env.LOADER.load(code());
  out.push(await w.getEntrypoint().ping());
  w.dispose();
}
return Response.json(out);`);
    await json(runtime); // warm up: the isolate entry is built once (its threads stay)
    const before = threads();
    expect(await json(runtime)).toEqual(Array(8).fill("pong"));
    // Eight threads would remain without the fix (several OS threads each).
    expect(await threadsDownTo(before)).toBeLessThanOrEqual(before);
  }, 60_000);

  it("a Worker that never yields ends on dispose(): its call rejects and its thread goes", async () => {
    const runtime = await project(`
const w = env.LOADER.load(code());
const e = w.getEntrypoint();
await e.ping();
const spinning = e.spin().then(() => "returned", (err) => "rejected: " + err.message);
await new Promise((r) => setTimeout(r, 100));
w.dispose();
const r = await spinning;
let after;
try { await e.ping(); after = "answered"; } catch (err) { after = "refused: " + err.message; }
return Response.json({ r, after });`);
    const before = threads();
    const out = (await json(runtime)) as { r: string; after: string };
    expect(out.r).toMatch(/^rejected: .*disposed/);
    expect(out.after).toMatch(/^refused: .*disposed/);
    expect(await threadsDownTo(before)).toBeLessThanOrEqual(before);
  }, 60_000);

  it("get(id) then dispose(): the cached isolate ends, and a later get() loads it again", async () => {
    const runtime = await project(`
let loads = 0;
const get = () => env.LOADER.get("cached", () => { loads++; return code(); });
const a = get();
const out = [await a.getEntrypoint().ping(), await get().getEntrypoint().ping(), loads];
a.dispose();
out.push(await get().getEntrypoint().ping(), loads);
get().dispose();
return Response.json(out);`);
    const before = threads();
    expect(await json(runtime)).toEqual(["pong", "pong", 1, "pong", 2]);
    expect(await threadsDownTo(before)).toBeLessThanOrEqual(before);
  }, 60_000);

  it("a Worker whose top-level code never yields ends on dispose() while it loads", async () => {
    const runtime = await project(
      `
const w = env.LOADER.load(code());
const call = w.getEntrypoint().ping().then(() => "returned", (err) => "rejected: " + err.message);
await new Promise((r) => setTimeout(r, 300));
w.dispose();
const r = await Promise.race([call, new Promise((r) => setTimeout(() => r("still pending"), 3000))]);
return Response.json({ r });`,
      "for (;;) {}\nexport default {};",
    );
    const before = threads();
    const out = (await json(runtime)) as { r: string };
    expect(out.r).toMatch(/^rejected: .*disposed/);
    expect(await threadsDownTo(before)).toBeLessThanOrEqual(before);
  }, 60_000);

  it("a second dispose() of a stale get(id) handle leaves the id's newer isolate alone", async () => {
    const runtime = await project(`
const get = () => env.LOADER.get("again", code);
const a = get();
await a.getEntrypoint().ping();
a.dispose();
const b = get();
await b.getEntrypoint().ping();
// b's call in flight: the stale handle's second dispose() must not end b's isolate
const inflight = b.getEntrypoint().spin().then(() => "returned", (err) => "rejected: " + err.message);
await new Promise((r) => setTimeout(r, 100));
a.dispose();
const r = await Promise.race([inflight, new Promise((r) => setTimeout(() => r("running"), 500))]);
b.dispose();
return Response.json({ r });`);
    expect(await json(runtime)).toEqual({ r: "running" });
  }, 60_000);
});
