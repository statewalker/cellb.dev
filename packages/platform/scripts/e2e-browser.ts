/**
 * The platform in a browser tab on cellb (dist/browser, `npm run build:browser`), checked in
 * Chromium behind a plain static file server:
 *
 *   tsx scripts/e2e-browser.ts
 *
 * The host tab starts the platform in a Dedicated Worker; every other request of the origin is
 * answered by it through the ServiceWorker. Then, from pages of that origin: the ESM CDN serves a
 * graph, the React project renders, the bundler builds hello-worker with esbuild-wasm in the tab,
 * and the notebooks compile and run.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readTree } from "@statewalker/cellb-platform-core/tree";
import { unzip, zip } from "@statewalker/cellb-platform-core/util";
import { chromiumOptions } from "./chromium.js";
import { startHost } from "./hosts.mjs";

const root = resolve(import.meta.dirname, "..");
const port = 20000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
const server = spawn(
  "python3",
  [
    "-m",
    "http.server",
    String(port),
    "--bind",
    "127.0.0.1",
    "--directory",
    join(root, "dist/browser"),
  ],
  { stdio: "ignore" },
);
// biome-ignore lint/suspicious/noExplicitAny: Playwright is installed on the machine, untyped here
const { chromium } = createRequire(import.meta.url)("playwright") as any;

const results: { check: string; ok: boolean; detail: string }[] = [];
async function check(name: string, fn: () => Promise<string>) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ check: name, ok: true, detail });
    console.log(`  ok   ${name}: ${detail} (${Date.now() - t} ms)`);
  } catch (e) {
    results.push({ check: name, ok: false, detail: String((e as Error).message) });
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch(chromiumOptions());
try {
  const context = await browser.newContext();
  const host = await context.newPage();
  const logs: string[] = [];
  host.on("console", (m: { text(): string }) => logs.push(m.text()));
  console.log("\n== cellb in Chromium");
  await check("host tab starts the platform", async () => {
    await host.goto(`${origin}/__cellb/`);
    await host.waitForFunction(
      () => document.body.dataset.ready === "true" || document.body.dataset.error,
      null,
      { timeout: 180_000 },
    );
    const error = await host.evaluate(() => document.body.dataset.error);
    assert(!error, `${error}\n${logs.slice(-20).join("\n")}`);
    return (await host.textContent("#status")) ?? "";
  });

  const page = await context.newPage();
  await page.goto(`${origin}/`);
  const call = (
    path: string,
    init?: { method?: string; body?: string | number[]; json?: boolean },
  ) =>
    page.evaluate(
      async ({
        path,
        init,
      }: {
        path: string;
        init?: { method?: string; body?: string | number[]; json?: boolean };
      }) => {
        const body = Array.isArray(init?.body) ? new Uint8Array(init.body) : init?.body;
        const r = await fetch(path, {
          method: init?.method ?? "GET",
          body,
          headers: init?.json ? { "content-type": "application/json" } : undefined,
          redirect: "follow",
        });
        return { status: r.status, url: r.url, text: await r.text() };
      },
      { path, init },
    );

  await check("cdn: react-dom/client graph", async () => {
    const g = await call("/npm/browser/react-dom@19/client?graph");
    assert(g.status === 200, `graph ${g.status}: ${g.text.slice(0, 300)}`);
    const urls = JSON.parse(g.text) as string[];
    for (const u of urls) assert((await call(u)).status === 200, u);
    return `${urls.length} modules`;
  });

  await check("projects: react-page renders", async () => {
    const files: Record<string, string> = {};
    for (const [p, b] of readTree(join(root, "fixtures/react-page")))
      files[p] = new TextDecoder().decode(b);
    const imp = await call("/p/react-page/import", {
      method: "POST",
      body: JSON.stringify({ files }),
      json: true,
    });
    assert(imp.status === 200, `import ${imp.status} ${imp.text}`);
    const snap = JSON.parse((await call("/p/react-page/snapshots", { method: "POST" })).text) as {
      base: string;
    };
    const p = await context.newPage();
    await p.goto(`${snap.base}~/index.html`);
    await p.waitForSelector("text=Hello from webrun", { timeout: 60_000 });
    await p.click("#inc");
    const label = await p.textContent("#inc");
    assert(label?.includes("1"), label);
    await p.close();
    return label ?? "";
  });

  await check("bundler: hello-worker built with esbuild-wasm in the tab", async () => {
    const z = zip([...readTree(join(root, "fixtures/hello-worker"))]);
    const r = await call("/builds?tier=object", { method: "POST", body: [...z] });
    const s = JSON.parse(r.text) as {
      status: string;
      id: string;
      error?: string;
      stats?: { packages: string[]; workerBytes: number };
    };
    assert(s.status === "done", `${s.status}: ${s.error}`);
    const w = await call(`/b/${s.id}/worker.js`);
    assert(w.status === 200 && w.text.includes("Counter"), "worker.js");
    return `build ${s.id}: ${s.stats?.packages.join(", ")}, ${s.stats?.workerBytes} bytes`;
  });

  await check("notebooks: compiled in the tab and run", async () => {
    const files: Record<string, string> = {};
    const dir = join(root, "../../examples/platform-demos/notebooks");
    for (const n of readdirSync(dir)) files[n] = readFileSync(join(dir, n), "utf8");
    assert(
      (
        await call("/nb/demo/import", {
          method: "POST",
          body: JSON.stringify({ files }),
          json: true,
        })
      ).status === 200,
      "import",
    );
    const b = await call("/nb/demo/build", { method: "POST" });
    assert(b.status === 200, `build ${b.status}: ${b.text.slice(0, 300)}`);
    const p = await context.newPage();
    await p.goto(`${origin}/nb/demo/plots.html`);
    await p.waitForSelector("#summary", { timeout: 90_000 });
    const summary = await p.textContent("#summary");
    assert(summary?.includes("60 points"), summary);
    await p.close();
    return summary ?? "";
  });

  await check(
    "astro: examples/platform-astro built from its sources in the tab, run on cellb, hydrated",
    async () => {
      const coi = await host.evaluate(() => globalThis.crossOriginIsolated);
      assert(coi, "the host tab is not cross-origin isolated");
      const z = zip([
        ...readTree(
          join(root, "../../examples/platform-astro"),
          join(root, "../../examples/platform-astro"),
          ["dist"],
        ),
      ]);
      const r = await call("/builds?tier=object&sourcemap=0", { method: "POST", body: [...z] });
      const s = JSON.parse(r.text) as {
        status: string;
        id: string;
        error?: string;
        log?: string[];
        stats?: { astro?: { routes: number; ms: number } };
      };
      assert(
        s.status === "done",
        `${s.status}: ${s.error ?? ""}\n${(s.log ?? []).slice(-8).join("\n")}`,
      );
      // The build's project.zip, out of the tab, run on cellb in Node.
      const b64 = (await page.evaluate(async (url: string) => {
        const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000)
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(bin);
      }, `/b/${s.id}/project.zip`)) as string;
      const out = mkdtempSync(join(tmpdir(), "webrun-tab-astro-"));
      for (const [f, bytes] of await unzip(new Uint8Array(Buffer.from(b64, "base64")))) {
        mkdirSync(dirname(join(out, f)), { recursive: true });
        writeFileSync(join(out, f), bytes);
      }
      const app = await startHost("cellb", out);
      try {
        const home = await fetch(`${app.url}/`)
          .then((r) => r.text())
          .catch((e) => `ERR ${e}`);
        assert(
          home.includes("Astro on the webrun platform"),
          `home: ${home.slice(0, 300)}\n${app.logs.join("").slice(-1500)}`,
        );
        const p = await context.newPage();
        await p.goto(`${app.url}/`);
        await p.waitForSelector("text=Astro on the webrun platform");
        await p.waitForFunction(
          () => document.querySelector("astro-island:not([ssr])") !== null,
          null,
          { timeout: 15_000 },
        );
        await p.click("#island");
        await p.waitForSelector("text=island clicks: 1", { timeout: 10_000 });
        await p.close();
      } finally {
        await app.stop();
      }
      return `build ${s.id}: ${s.stats?.astro?.routes} routes in ${s.stats?.astro?.ms} ms in the tab; ran on cellb, island hydrated`;
    },
  );

  await check(
    "notebooks: the Astro theme built in the tab renders the page models, cells run",
    async () => {
      const theme = join(root, "../notebooks/theme");
      const z = zip([...readTree(theme, theme, ["node_modules", "dist"])]);
      const r = await call("/builds?tier=object&sourcemap=0", { method: "POST", body: [...z] });
      const s = JSON.parse(r.text) as {
        status: string;
        id: string;
        error?: string;
        log?: string[];
      };
      assert(
        s.status === "done",
        `${s.status}: ${s.error ?? ""}\n${(s.log ?? []).slice(-8).join("\n")}`,
      );
      const put = await call("/nb/demo/theme", {
        method: "PUT",
        body: JSON.stringify({ build: s.id }),
        json: true,
      });
      assert(put.status === 204, `PUT theme ${put.status} ${put.text}`);
      const p = await context.newPage();
      await p.goto(`${origin}/nb/demo/t/plots`);
      await p.waitForSelector(".site-nav", { timeout: 60_000 });
      await p.waitForSelector("#summary", { timeout: 90_000 });
      const summary = await p.textContent("#summary");
      assert(summary?.includes("60 points"), summary);
      await p.close();
      const exp = await call("/nb/demo/export", { method: "POST" });
      assert(exp.status === 200, `export ${exp.status}: ${exp.text.slice(0, 300)}`);
      return `theme build ${s.id} in the tab; /nb/demo/t/plots: ${summary}; exported in the tab`;
    },
  );
} finally {
  await browser.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
