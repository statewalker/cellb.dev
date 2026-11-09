/**
 * The demos, end to end, on each host:
 *
 *   tsx scripts/e2e.ts [wrangler|celld|cellb|all] [astro] [emdash] [notebooks] [--no-browser]
 *
 * For each host: the platform (../dist/platform, `npm run build` in ..) is started on it; each
 * demo is built by its own toolchain where it needs one (Astro, on Node), sent to the platform's
 * bundler (which places it: in a Durable Object when small, on the Node runner when large), and
 * the bundle the platform returns is unpacked and run on the same host, where its pages are
 * checked over HTTP and in Chromium.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromiumOptions } from "../../../packages/platform/scripts/chromium.js";
import { HOSTS, type RunningHost, startHost } from "../../../packages/platform/scripts/hosts.mjs";
import { readTree } from "../../../packages/platform-core/src/tree.js";
import { unzip, zip } from "../../../packages/platform-core/src/util.js";
import { astroProject } from "./astro-project.js";
import { notebooksDemo } from "./notebooks.js";

// This package (the notebooks, the results), the examples next to it, and the platform package.
const demos = resolve(import.meta.dirname, "..");
const examples = resolve(demos, "..");
const platformRoot = resolve(examples, "../packages/platform");
const bundlerRoot = resolve(examples, "../packages/bundler");
const args = process.argv.slice(2);
// Positional arguments: the host, then the demos; `--emdash-tier <tier>` takes a value.
const positional = args.filter(
  (a, i) => !a.startsWith("--") && !["--emdash-tier", "--emdash-src-tier"].includes(args[i - 1]),
);
const hostArg =
  HOSTS.includes(positional[0]) || positional[0] === "all" ? positional.shift() : "all";
const hosts = hostArg === "all" ? HOSTS : [hostArg as string];
const apps = positional.length
  ? positional
  : ["astro", "astro-src", "emdash", "emdash-src", "notebooks"];
const browserOn = !args.includes("--no-browser");
// `--emdash-tier object` bundles EmDash inside the BuildJob object instead of on the Node runner
// (celld needs CELLD_V8_HEAP_LIMIT_MB=2048 for it; Cloudflare's 128 MB isolates cannot).
// `--emdash-src-tier object` builds EmDash from its sources in the object (esbuild-wasm and the
// compiler as WebAssembly; a Worker Loader isolate on workerd and celld) instead of on the runner.
const emdashSrcTier = args.includes("--emdash-src-tier")
  ? args[args.indexOf("--emdash-src-tier") + 1]
  : "runner";
/** EmDash's integration reads its own and its admin's files at build time. */
const EMDASH_SPEC = {
  astro: {
    preload: [["emdash"], ["@emdash-cms/admin", "emdash"]],
    metaUrl: "file:///node_modules/emdash/dist/astro/index.mjs",
  },
};
const emdashTier = args.includes("--emdash-tier")
  ? args[args.indexOf("--emdash-tier") + 1]
  : "auto";

const results: { host: string; check: string; ok: boolean; detail: string }[] = [];
async function check(host: string, name: string, fn: () => Promise<string>) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ host, check: name, ok: true, detail: `${detail} (${Date.now() - t} ms)` });
    console.log(`  ok   ${name}: ${detail} (${Date.now() - t} ms)`);
    return true;
  } catch (e) {
    results.push({ host, check: name, ok: false, detail: String((e as Error).message ?? e) });
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
    return false;
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
// biome-ignore lint/suspicious/noExplicitAny: Playwright is installed on the machine, untyped here
const playwright = () => createRequire(import.meta.url)("playwright") as any;

function ensureBuilt(app: string) {
  const dir = join(examples, app);
  if (existsSync(join(dir, "dist/server/wrangler.json"))) return;
  console.log(`  building ${app} with Astro…`);
  const r = spawnSync("pnpm", ["run", "build"], { cwd: dir, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${app}: astro build failed`);
}

/** Sends `files` to the platform's bundler; runs the Node runner when the build is queued for it. */
async function bundleOnPlatform(
  base: string,
  files: Map<string, Uint8Array>,
  query = "",
  headers: Record<string, string> = {},
) {
  // One retry on a network error: a build is named by its inputs, so sending it twice makes it
  // once. (wrangler dev once dropped a 38 MB upload sent while the machine was busy.)
  const body = zip([...files]) as BodyInit;
  const send = () => fetch(`${base}/builds${query}`, { method: "POST", headers, body });
  const res = await send().catch(async (e) => {
    console.log(`  (retrying the upload: ${e?.cause?.code ?? e?.message ?? e})`);
    return send();
  });
  let s = (await res.json()) as {
    id: string;
    status: string;
    tier: string;
    error?: string;
    log: string[];
    stats?: Record<string, unknown>;
  };
  if (s.status === "queued") {
    await new Promise<void>((ok, fail) => {
      const p = spawn(
        process.execPath,
        [
          join(platformRoot, "node_modules/tsx/dist/cli.mjs"),
          join(bundlerRoot, "bin/webrun-build.ts"),
          "--runner",
          base,
          "--once",
        ],
        {
          stdio: ["ignore", "inherit", "inherit"],
        },
      );
      p.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`runner exited ${code}`))));
    });
    s = (await (await fetch(`${base}/builds/${s.id}`)).json()) as typeof s;
  }
  assert(s.status === "done", `build ${s.id} ${s.status}: ${s.error ?? s.log.join("\n")}`);
  return s;
}

/** Unpacks a build's project.zip; `vars` are deployment settings added to its wrangler.json. */
async function unpackBuild(base: string, id: string, vars: Record<string, string> = {}) {
  const z = await fetch(`${base}/b/${id}/project.zip`);
  assert(z.ok, `project.zip ${z.status}`);
  const out = mkdtempSync(join(tmpdir(), `webrun-demo-${id}-`));
  for (const [p, b] of await unzip(new Uint8Array(await z.arrayBuffer()))) {
    mkdirSync(dirname(join(out, p)), { recursive: true });
    writeFileSync(join(out, p), b);
  }
  const cfgPath = join(out, "wrangler.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.vars = { ...cfg.vars, ...vars };
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  return out;
}

const freePort = () => 20000 + Math.floor(Math.random() * 20000);

/**
 * `dist`: Astro's own build (Node), bundled by the platform. `sources`: the sources alone, built
 * by the platform's port of cellb.dev's in-browser Astro builder, in the BuildJob object.
 */
async function astroDemo(host: string, base: string, from: "dist" | "sources" = "dist") {
  const label = from === "dist" ? "astro" : "astro-src";
  const dirOf = join(examples, "platform-astro");
  if (from === "dist") ensureBuilt("platform-astro");
  let id = "";
  const built = await check(
    host,
    `${label}: ${from === "dist" ? "bundled" : "built from its sources"} by the platform`,
    async () => {
      const s =
        from === "dist"
          ? await bundleOnPlatform(base, astroProject(dirOf))
          : await bundleOnPlatform(
              base,
              readTree(dirOf, dirOf, ["dist"]),
              "?tier=object&sourcemap=0",
            );
      id = s.id;
      return `build ${s.id}, tier ${s.tier}, ${JSON.stringify(s.stats?.workerBytes)} bytes${s.stats?.astro ? `, Astro: ${JSON.stringify(s.stats.astro)}` : ""}`;
    },
  );
  if (!built) return;
  const dir = await unpackBuild(base, id);
  let app: RunningHost | undefined;
  try {
    await check(host, `${label}: SSR, Durable Object, API route, assets`, async () => {
      app = await startHost(host, dir);
      const first = await (await fetch(`${app.url}/`)).text();
      assert(first.includes("Astro on the webrun platform"), `home: ${first.slice(0, 300)}`);
      const second = await (await fetch(`${app.url}/`)).text();
      const n = (html: string) => Number(html.match(/visits: (\d+)/)?.[1]);
      assert(n(second) === n(first) + 1, `visits ${n(first)} then ${n(second)}`);
      const post = await (await fetch(`${app.url}/posts/hello`)).text();
      assert(post.includes("Post: hello"), "post");
      const api = (await (await fetch(`${app.url}/api/time`)).json()) as { ok: boolean };
      assert(api.ok, "api");
      const asset = second.match(/\/_astro\/[^"']+\.js/)?.[0];
      assert(asset, "no client script in the page");
      assert((await fetch(`${app.url}${asset}`)).ok, `asset ${asset}`);
      return "home, visits counter, post, API, client asset";
    });
    if (browserOn && app)
      await check(host, `${label}: React island hydrates in Chromium`, async () => {
        const b = await playwright().chromium.launch(chromiumOptions());
        try {
          const page = await b.newPage();
          await page.goto(`${app?.url}/`);
          await page.waitForSelector("#island");
          await page.waitForFunction(
            () => document.querySelector("astro-island:not([ssr])") !== null,
            null,
            { timeout: 15000 },
          );
          await page.click("#island");
          await page.waitForSelector("text=island clicks: 1", { timeout: 10000 });
          return "hydrated, clicked";
        } finally {
          await b.close();
        }
      });
  } finally {
    await app?.stop();
  }
}

async function emdashDemo(host: string, base: string, from: "dist" | "sources" = "dist") {
  const label = from === "dist" ? "emdash" : "emdash-src";
  const dirOf = join(examples, "emdash");
  if (from === "dist") ensureBuilt("emdash");
  let id = "";
  const built = await check(
    host,
    `${label}: ${from === "dist" ? "bundled" : "built from its sources"} by the platform`,
    async () => {
      // From sources: the app alone (cellb's emdash example also holds its tests, screenshots and
      // the browser host of its static build).
      const files =
        from === "dist"
          ? astroProject(dirOf)
          : readTree(dirOf, dirOf, ["dist", "test", "screenshots", "browser", "scripts"]);
      const bytes = [...files.values()].reduce((n, b) => n + b.length, 0);
      const s =
        from === "dist"
          ? await bundleOnPlatform(base, files, `?tier=${emdashTier}`)
          : await bundleOnPlatform(base, files, `?tier=${emdashSrcTier}&sourcemap=0`, {
              "x-build-spec": JSON.stringify(EMDASH_SPEC),
            });
      id = s.id;
      return `build ${s.id}, ${files.size} input files (${(bytes / 1e6).toFixed(1)} MB), tier ${s.tier}, worker ${((s.stats?.workerBytes as number) / 1e6).toFixed(1)} MB${s.stats?.astro ? `, Astro: ${JSON.stringify(s.stats.astro)}` : ""}`;
    },
  );
  if (!built) return;
  const port = freePort();
  const origin = `http://127.0.0.1:${port}`;
  const dir = await unpackBuild(base, id, { EMDASH_SITE_URL: origin });
  let app: RunningHost | undefined;
  try {
    await check(host, `${label}: setup seeds D1, pages render`, async () => {
      app = await startHost(host, dir, { port, timeoutMs: 180_000 });
      const get = (p: string) => fetch(`${origin}${p}`, { redirect: "manual" });
      const status = (await (await get("/_emdash/api/setup/status")).json()) as {
        data: { needsSetup: boolean };
      };
      assert(status.data.needsSetup, `setup status ${JSON.stringify(status)}`);
      let seeded = false;
      for (let i = 0; i < 15 && !seeded; i++) {
        const r = await fetch(`${origin}/_emdash/api/setup`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-emdash-request": "1", origin },
          body: JSON.stringify({
            title: `EmDash on ${host}`,
            tagline: "Bundled by webrun",
            includeContent: true,
          }),
        });
        const body = await r.text();
        assert(r.status === 200, `setup ${r.status}: ${body.slice(0, 400)}`);
        seeded = (JSON.parse(body) as { data: { seedComplete: boolean } }).data.seedComplete;
      }
      assert(seeded, "seed did not complete");
      const home = await (await get("/")).text();
      assert(home.includes(`EmDash on ${host}`), "home title");
      assert(home.includes("Notes on Simplicity"), "seeded post on home");
      const post = await get("/posts/notes-on-simplicity");
      assert(
        post.status === 200 && (await post.text()).includes("Notes on Simplicity"),
        "post page",
      );
      const rss = await (await get("/rss.xml")).text();
      assert(rss.includes("<rss"), "rss");
      const admin = await get("/_emdash/admin");
      assert([200, 302].includes(admin.status), `admin ${admin.status}`);
      return "setup wizard seeded D1; home, post, RSS and admin answer";
    });
    if (browserOn && app)
      await check(host, `${label}: home and post render in Chromium`, async () => {
        const b = await playwright().chromium.launch(chromiumOptions());
        try {
          const page = await b.newPage();
          const errors: string[] = [];
          page.on("pageerror", (e: Error) => errors.push(e.message));
          await page.goto(`${origin}/`);
          await page.waitForSelector("text=Notes on Simplicity");
          await page.click("text=Notes on Simplicity");
          await page.waitForURL(/notes-on-simplicity/);
          const h1 = await page.textContent("h1");
          assert(h1?.includes("Notes on Simplicity"), `h1 ${h1}`);
          return `navigated to the post${errors.length ? `; page errors: ${errors.join("; ")}` : ""}`;
        } finally {
          await b.close();
        }
      });
  } finally {
    await app?.stop();
  }
}

for (const host of hosts) {
  console.log(`\n== ${host}`);
  const dir = join(platformRoot, "dist/platform", host === "cellb" ? "cellb" : "workerd");
  const platform = await startHost(host, dir);
  try {
    if (apps.includes("astro")) await astroDemo(host, platform.url);
    if (apps.includes("astro-src")) await astroDemo(host, platform.url, "sources");
    if (apps.includes("emdash")) await emdashDemo(host, platform.url);
    if (apps.includes("emdash-src")) await emdashDemo(host, platform.url, "sources");
    if (apps.includes("notebooks"))
      await notebooksDemo(host, platform.url, { check, assert, browserOn, playwright });
  } finally {
    await platform.stop();
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
writeFileSync(join(demos, "e2e-results.json"), `${JSON.stringify(results, null, 2)}\n`);
process.exit(failed.length ? 1 : 0);
