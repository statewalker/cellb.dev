/**
 * End-to-end check of the platform on one host (or all):
 *
 *   tsx scripts/e2e.ts [wrangler|celld|cellb|all] [--no-browser]
 *
 * For each host, the platform's build for that host (dist/platform/workerd or …/cellb, made by
 * `npm run build`) is started, then:
 *   1. ESM CDN: a package resolves, its graph is served, CSS goes through Lightning CSS.
 *   2. User code as ESM: fixtures/react-page is imported, snapshotted and served; every URL of
 *      its graph answers; Chromium renders it and its button works.
 *   3. Bundler, in-object tier: fixtures/hello-worker is built in a BuildJob object; the build's
 *      project.zip is unpacked and run on the same host; its routes, Durable Object and assets
 *      answer.
 *   4. Bundler, runner tier: the same project queued for a Node runner, which builds and uploads.
 */
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { readTree } from "@statewalker/cellb-platform-core/tree";
import { unzip, zip } from "@statewalker/cellb-platform-core/util";
import { chromiumOptions } from "./chromium.js";
import { HOSTS, startHost } from "./hosts.mjs";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const which = args.find((a) => !a.startsWith("--")) ?? "all";
const browser = !args.includes("--no-browser");
const hosts = which === "all" ? HOSTS : [which];

const results: { host: string; check: string; ok: boolean; detail: string }[] = [];
async function check(host: string, name: string, fn: () => Promise<string>) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ host, check: name, ok: true, detail: `${detail} (${Date.now() - t} ms)` });
    console.log(`  ok   ${name}: ${detail}`);
  } catch (e) {
    results.push({ host, check: name, ok: false, detail: String((e as Error).message ?? e) });
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function runPlatform(host: string) {
  console.log(`\n== ${host}`);
  const dir = join(root, "dist/platform", host === "cellb" ? "cellb" : "workerd");
  const platform = await startHost(host, dir);
  const base = platform.url;
  try {
    await check(host, "cdn: resolve + graph", async () => {
      const r = await fetch(`${base}/npm/browser/react-dom@19/client`, { redirect: "manual" });
      assert(r.status === 302, `expected 302, got ${r.status}`);
      const graph = (await (
        await fetch(`${base}/npm/browser/react-dom@19/client?graph`)
      ).json()) as string[];
      assert(graph.length > 3, `graph too small: ${graph.length}`);
      for (const u of graph) {
        const m = await fetch(`${base}${u}`);
        assert(m.status === 200, `${u}: ${m.status}`);
        await m.body?.cancel();
      }
      const css = await (
        await fetch(`${base}/npm/browser/@picocss/pico@2/css/pico.css?module`)
      ).text();
      assert(css.includes("--pico-font-family"), "css module");
      return `${graph.length} modules`;
    });

    await check(host, "cdn: a large graph (@observablehq/plot, d3)", async () => {
      const graph = (await (
        await fetch(`${base}/npm/browser/@observablehq/plot@0.6?graph`)
      ).json()) as string[];
      assert(graph.length > 50, `graph too small: ${graph.length}`);
      let bytes = 0;
      for (const u of graph) {
        const m = await fetch(`${base}${u}`);
        assert(m.status === 200, `${u}: ${m.status}`);
        bytes += (await m.arrayBuffer()).byteLength;
      }
      return `${graph.length} modules, ${(bytes / 1e6).toFixed(1)} MB`;
    });

    let pageUrl = "";
    await check(host, "projects: react-page as ESM", async () => {
      const files: Record<string, string> = {};
      for (const [p, b] of readTree(join(root, "fixtures/react-page")))
        files[p] = new TextDecoder().decode(b);
      const imp = await fetch(`${base}/p/react-page/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files }),
      });
      assert(imp.ok, `import ${imp.status} ${await imp.text()}`);
      const snap = (await (
        await fetch(`${base}/p/react-page/snapshots`, { method: "POST" })
      ).json()) as { base: string; snapshot: string };
      const main = await fetch(`${snap.base}~/src/main.tsx`);
      const mainText = await main.text();
      assert(main.status === 200, `main.tsx ${main.status}: ${mainText.slice(0, 300)}`);
      assert(!mainText.includes("<App"), "JSX not compiled");
      const res = (await (
        await fetch(`${snap.base}resolve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entries: ["src/main.tsx"] }),
        })
      ).json()) as { urls: Record<string, string>; preload: string[] };
      for (const u of res.preload) {
        const m = await fetch(new URL(u, base));
        assert(m.status === 200, `${u}: ${m.status} ${(await m.text()).slice(0, 200)}`);
      }
      pageUrl = `${snap.base}~/index.html`;
      return `snapshot ${snap.snapshot}, ${res.preload.length} project modules`;
    });

    if (browser && pageUrl)
      await check(host, "projects: page renders in Chromium", async () => {
        // Playwright and its Chromium are installed on the machine, not by this package.
        // biome-ignore lint/suspicious/noExplicitAny: an untyped optional dependency
        const { chromium } = createRequire(import.meta.url)("playwright") as any;
        const b = await chromium.launch(chromiumOptions());
        try {
          const page = await b.newPage();
          const errors: string[] = [];
          page.on("pageerror", (e: Error) => errors.push(e.message));
          await page.goto(pageUrl);
          await page.waitForSelector("text=Hello from webrun", { timeout: 30000 });
          await page.click("#inc");
          await page.click("#inc");
          const label = await page.textContent("#inc");
          assert(label?.includes("2"), `button says ${label}`);
          const color = await page.$eval("h1", (e: Element) => getComputedStyle(e).color);
          assert(color === "rgb(102, 51, 153)", `css not applied: ${color}`);
          assert(errors.length === 0, errors.join("; "));
          return `rendered, ${label}`;
        } finally {
          await b.close();
        }
      });

    const project = zip([...readTree(join(root, "fixtures/hello-worker"))]);
    let buildId = "";
    await check(host, "bundler: in-object build", async () => {
      const r = await fetch(`${base}/builds?tier=object`, {
        method: "POST",
        body: project as BodyInit,
      });
      const s = (await r.json()) as {
        id: string;
        status: string;
        error?: string;
        stats?: { packages: string[] };
        log: string[];
      };
      assert(s.status === "done", `status ${s.status}: ${s.error ?? s.log.join("\n")}`);
      buildId = s.id;
      return `build ${s.id}, packages ${s.stats?.packages.join(", ")}`;
    });

    if (buildId)
      await check(host, "bundler: the build runs on the same host", async () => {
        const z = await fetch(`${base}/b/${buildId}/project.zip`);
        assert(z.ok, `project.zip ${z.status}`);
        const out = mkdtempSync(join(tmpdir(), "webrun-build-"));
        for (const [p, b] of await unzip(new Uint8Array(await z.arrayBuffer()))) {
          mkdirSync(dirname(join(out, p)), { recursive: true });
          writeFileSync(join(out, p), b);
        }
        const loader = await fetch(`${base}/b/${buildId}/loader.json`);
        assert(
          ((await loader.json()) as { mainModule: string }).mainModule === "worker.js",
          "loader.json",
        );
        const app = await startHost(host, out);
        try {
          const hello = (await (await fetch(`${app.url}/api/hello`)).json()) as { hello: string };
          assert(hello.hello === "world", JSON.stringify(hello));
          await fetch(`${app.url}/api/count/a`);
          const c = (await (await fetch(`${app.url}/api/count/a`)).json()) as { n: number };
          assert(c.n === 2, `counter ${JSON.stringify(c)}`);
          const page = await (await fetch(`${app.url}/`)).text();
          assert(page.includes("Bundled by the webrun platform"), "assets");
          return "routes, Durable Object and assets answer";
        } finally {
          await app.stop();
        }
      });

    await check(host, "guards: traversal, registry paths, internal build actions", async () => {
      const put = await fetch(`${base}/p/guard/files/..%2fsnap%2f0000000000000000%2fx.ts`, {
        method: "PUT",
        body: "x",
      });
      assert(put.status === 400, `traversal PUT: ${put.status}`);
      const imp = await fetch(`${base}/p/guard/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files: { "../snap/x": "x" } }),
      });
      assert(imp.status === 400, `traversal import: ${imp.status}`);
      const reg = await fetch(`${base}/registry/react/latest`);
      assert(reg.status === 400, `registry /react/latest: ${reg.status}`);
      const cdn = await fetch(`${base}/npm/browser/%E0%A4%A`);
      assert(cdn.status === 400, `malformed CDN spec: ${cdn.status}`);
      const create = await fetch(`${base}/builds/0123456789abcdef0123/create`, {
        method: "POST",
        body: "x",
      });
      assert(create.status === 404, `outside create: ${create.status}`);
      if (buildId) {
        const out = await fetch(`${base}/builds/${buildId}/output`, { method: "PUT", body: "x" });
        assert(out.status === 409, `output over a finished build: ${out.status}`);
      }
      return "400 traversal and bad paths, 404 internal actions, 409 output over a finished build";
    });

    await check(host, "bundler: runner tier (Node)", async () => {
      const r = await fetch(`${base}/builds?tier=runner&minify=1`, {
        method: "POST",
        body: project as BodyInit,
      });
      const s = (await r.json()) as { id: string; status: string };
      assert(s.status === "queued", `status ${s.status}`);
      await new Promise<void>((ok, fail) => {
        const p = spawn(
          process.execPath,
          [
            createRequire(join(root, "package.json")).resolve("tsx/cli"),
            createRequire(join(root, "package.json"))
              .resolve("@statewalker/cellb-bundler/package.json")
              .replace(/package\.json$/, "bin/webrun-build.ts"),
            "--runner",
            base,
            "--once",
          ],
          { stdio: "inherit" },
        );
        p.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`runner exited ${code}`))));
      });
      const done = (await (await fetch(`${base}/builds/${s.id}`)).json()) as {
        status: string;
        stats: { tier: string };
      };
      assert(done.status === "done", `status ${done.status}`);
      const w = await fetch(`${base}/b/${s.id}/worker.js`);
      assert(w.ok, `worker.js ${w.status}`);
      return `build ${s.id} by ${done.stats.tier}`;
    });
  } finally {
    await platform.stop();
  }
}

for (const h of hosts) await runPlatform(h);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
writeFileSync(join(root, "e2e-results.json"), `${JSON.stringify(results, null, 2)}\n`);
process.exit(failed.length ? 1 : 0);
