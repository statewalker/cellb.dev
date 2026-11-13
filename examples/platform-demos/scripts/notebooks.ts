/**
 * The notebooks demo: demos/notebooks (a Markdown notebook and an Observable Notebook Kit HTML
 * document) sent to the platform, compiled to pages in a NotebookSite object, and opened in
 * Chromium, where their cells run with d3 and Observable Plot from the platform's module server.
 *
 * Then the same notebooks through a theme: packages/notebooks/theme (an Astro project) built from
 * its sources by the platform's bundler, set as the site's theme, and rendering the page models
 * the build wrote, in a Worker Loader isolate. A notebook edit and rebuild change the themed page
 * without a new theme build, and the themed page's cells run in Chromium.
 *
 * Last, the themed site exported as static files (POST /nb/<site>/export), served by a plain file
 * server with nothing of the platform behind it, and its cells run in Chromium from those files.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { chromiumOptions } from "../../../packages/platform/scripts/chromium.js";
import { readTree } from "../../../packages/platform-core/src/tree.js";
import { unzip } from "../../../packages/platform-core/src/util.js";

type Check = (host: string, name: string, fn: () => Promise<string>) => Promise<boolean>;
interface Tools {
  check: Check;
  assert: (cond: unknown, msg: string) => asserts cond;
  browserOn: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: Playwright is untyped here
  playwright: () => any;
  /** Sends a project to the platform's bundler and waits for the build. */
  bundle: (files: Map<string, Uint8Array>, query?: string) => Promise<{ id: string }>;
}

const dir = resolve(import.meta.dirname, "../notebooks");
const themeDir = resolve(import.meta.dirname, "../../../packages/notebooks/theme");

export async function notebooksDemo(host: string, base: string, t: Tools) {
  const { check, browserOn } = t;
  const assert: Tools["assert"] = t.assert;
  const site = `${base}/nb/demo`;
  const built = await check(host, "notebooks: compiled to pages in a Durable Object", async () => {
    const files: Record<string, string> = {};
    for (const n of readdirSync(dir)) files[n] = readFileSync(join(dir, n), "utf8");
    const imp = await fetch(`${site}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files }),
    });
    assert(imp.ok, `import ${imp.status}`);
    const r = await fetch(`${site}/build`, { method: "POST" });
    const body = await r.text();
    assert(r.ok, `build ${r.status}: ${body.slice(0, 500)}`);
    const res = JSON.parse(body) as {
      pages: string[];
      failures: { notebook: string; error: string }[];
      ms: number;
      models: number;
      modelFailures: { notebook: string; error: string }[];
      loaders: { output: string; cached: boolean; bytes: number }[];
      loaderFailures: { loader: string; error: string }[];
    };
    assert(
      res.pages.includes("/plots.html") && res.pages.includes("/index.html"),
      `pages ${res.pages}`,
    );
    // A loader first: a failed one fails the page that reads its output.
    assert(
      res.loaderFailures.length === 0,
      `loader failures ${JSON.stringify(res.loaderFailures)}`,
    );
    assert(res.failures.length === 0, `failures ${JSON.stringify(res.failures)}`);
    assert(res.models === 3, `${res.models} page models`);
    assert(res.modelFailures.length === 0, `model failures ${JSON.stringify(res.modelFailures)}`);
    // The data loader: built, run, its output served beside the pages; its source is not.
    assert(
      res.loaders.some((l) => l.output === "/numbers.json"),
      `loaders ${JSON.stringify(res.loaders)}`,
    );
    const numbers = (await (await fetch(`${site}/numbers.json`)).json()) as number[];
    assert(numbers.join() === "1,2,3,4,5,6,7,8,9,10", `numbers.json: ${numbers}`);
    assert(
      (await fetch(`${site}/numbers.json.js`)).status === 404,
      "the loader's source is served",
    );
    const again = (await (await fetch(`${site}/build`, { method: "POST" })).json()) as typeof res;
    assert(
      again.loaders.find((l) => l.output === "/numbers.json")?.cached === true,
      "an unchanged loader ran again",
    );
    const page = await (await fetch(`${site}/plots.html`)).text();
    assert(page.includes("/nb/demo/_m/"), "the page does not import from the module server");
    const css = /<link rel="stylesheet" href="([^"]+)"/.exec(page)?.[1];
    assert(css, "the page links no stylesheet");
    const sheet = await fetch(new URL(css, site));
    assert(sheet.ok, `stylesheet ${css}: ${sheet.status}`);
    assert(
      /text\/css/.test(sheet.headers.get("content-type") ?? ""),
      `stylesheet ${css} is not CSS`,
    );
    return `${res.pages.length} pages in ${res.ms} ms; a data loader's output, kept on rebuild; stylesheet ${css.replace(/^.*\/_m\//, "")}`;
  });
  if (!built) return;
  if (browserOn) await plainPagesInBrowser(host, site, t);
  await themedDemo(host, site, t);
}

async function plainPagesInBrowser(host: string, site: string, t: Tools) {
  const { check, playwright } = t;
  const assert: Tools["assert"] = t.assert;
  await check(host, "notebooks: cells run in Chromium (d3, Plot, Inputs)", async () => {
    const b = await playwright().chromium.launch(chromiumOptions());
    try {
      const page = await b.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      await page.goto(`${site}/plots.html`);
      await page.waitForSelector("#summary", { timeout: 60000 });
      const summary = await page.textContent("#summary");
      assert(summary?.includes("60 points"), `summary: ${summary}`);
      await page.waitForSelector("svg", { timeout: 30000 });
      const dots = await page.$$eval("svg circle", (c: Element[]) => c.length);
      assert(dots === 60, `Plot drew ${dots} dots`);
      // The range input drives the other cells.
      await page.fill('input[type="number"]', "100");
      await page.press('input[type="number"]', "Enter");
      await page.waitForFunction(
        () => document.querySelector("#summary")?.textContent?.includes("100 points"),
        null,
        { timeout: 15000 },
      );
      await page.goto(`${site}/index.html`);
      await page.waitForSelector("svg", { timeout: 60000 });
      assert(errors.length === 0, `page errors: ${errors.join("; ")}`);
      return "Plot drew 60 dots, the input re-ran the cells (100 points); index.md rendered";
    } finally {
      await b.close();
    }
  });
}

async function themedDemo(host: string, site: string, t: Tools) {
  const { check, browserOn, playwright } = t;
  const assert: Tools["assert"] = t.assert;
  let themeBuild = "";
  const themed = await check(
    host,
    "notebooks: an Astro theme renders the page models",
    async () => {
      const s = await t.bundle(
        readTree(themeDir, themeDir, ["node_modules", "dist"]),
        "?tier=object&sourcemap=0",
      );
      themeBuild = s.id;
      const put = await fetch(`${site}/theme`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ build: s.id }),
      });
      assert(put.status === 204, `PUT theme ${put.status}`);
      const res = await fetch(`${site}/t/plots`);
      const html = await res.text();
      assert(res.status === 200, `themed page ${res.status}: ${html.slice(0, 300)}`);
      assert(html.includes('class="site-nav"'), "no navigation");
      assert(/aria-current="page"/.test(html), "the current page is not marked");
      assert(
        html.includes('<script type="module">import {define} from "/nb/demo/_m/'),
        "no define() script",
      );
      assert(html.includes('href="/nb/demo/t/"'), "no link to the themed home page");
      assert((await fetch(`${site}/t/`)).status === 200, "themed home page");
      assert((await fetch(`${site}/t/no-such-page`)).status === 404, "a missing page is not a 404");
      const search = (await (await fetch(`${site}/search.json`)).json()) as {
        pages: { path: string; title: string }[];
        entries: { p: number; h: string; a: string; t: string }[];
      };
      assert(search.pages.length === 3, `search index pages: ${search.pages.length}`);
      const answer = search.entries.find((e) => e.t.includes("The answer is"));
      assert(
        answer && search.pages[answer.p]?.path === "/nb/demo/t/features",
        "no search entry for the features notebook's prose",
      );
      assert(html.includes('class="site-search"'), "no search box");
      return `theme build ${s.id}; /t/plots and /t/ rendered from the page models; search index: ${search.entries.length} sections`;
    },
  );
  if (!themed) return;

  await check(
    host,
    "notebooks: an edit reaches the themed page without a theme build",
    async () => {
      const original = readFileSync(join(dir, "index.md"), "utf8");
      const edited = original.replace(/^# .*$/m, "# Edited after the theme was built");
      assert(edited !== original, "index.md has no title heading to edit");
      const write = (text: string) =>
        fetch(`${site}/files/index.md`, { method: "PUT", body: text }).then((r) => r.status);
      try {
        assert((await write(edited)) === 204, "PUT index.md");
        assert((await fetch(`${site}/build`, { method: "POST" })).ok, "rebuild");
        const html = await (await fetch(`${site}/t/`)).text();
        assert(html.includes("Edited after the theme was built"), "the themed page did not change");
        const models = (await (await fetch(`${site}/models.json`)).json()) as {
          site: { title: string };
        };
        assert(
          models.site.title === "Edited after the theme was built",
          `site title ${models.site.title}`,
        );
      } finally {
        await write(original);
        await fetch(`${site}/build`, { method: "POST" });
      }
      return `same theme build ${themeBuild}, new page models`;
    },
  );

  await check(
    host,
    "notebooks: echo, run=false and inline expressions in the themed page",
    async () => {
      const html = await (await fetch(`${site}/t/features`)).text();
      // cells: the expression 1, the echo cell 2, the run=false cell 3
      assert(html.includes('<span id="cell-1" class="expr"></span>'), "no span for the expression");
      assert(html.includes('<div id="cell-2" class="cell">'), "no root for the echo cell");
      assert(
        html.includes(
          '<pre class="cell-source"><code class="language-js">const answer = 6 * 7;</code></pre>',
        ),
        "the echo cell's source is not shown",
      );
      assert(!html.includes('id="cell-3"'), "the run=false cell has a root");
      assert(html.includes("this cell must not run"), "the run=false cell's source is not shown");
      assert(!/getElementById\("cell-3"\)/.test(html), "the run=false cell is defined");
      return "the expression's span, the echo cell's source, the run=false cell shown and not defined";
    },
  );

  await exportDemo(host, site, t);

  if (!browserOn) return;
  await check(host, "notebooks: an inline expression displays its value in Chromium", async () => {
    const b = await playwright().chromium.launch(chromiumOptions());
    try {
      const page = await b.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      await page.goto(`${site}/t/features`);
      await page.waitForFunction(
        () => document.querySelector("#cell-1")?.textContent?.includes("42"),
        null,
        { timeout: 30000 },
      );
      const sentence = await page.textContent(".prose p");
      assert(sentence?.includes("The answer is 42"), `sentence: ${sentence}`);
      // FileAttachment("numbers.json") on the themed page: the data loader's output
      await page.waitForFunction(
        () => document.body.textContent?.includes("10 numbers, summing to 55"),
        null,
        { timeout: 30000 },
      );
      assert(errors.length === 0, `page errors: ${errors.join("; ")}`);
      return `"${sentence?.trim().slice(0, 60)}…"; the loader's data: 10 numbers, summing to 55; no page error`;
    } finally {
      await b.close();
    }
  });

  await check(host, "notebooks: the themed page's cells run in Chromium", async () => {
    const b = await playwright().chromium.launch(chromiumOptions());
    try {
      const page = await b.newPage();
      const errors: string[] = [];
      const offOrigin: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      page.on("request", (r: { url(): string }) => {
        if (new URL(r.url()).origin !== new URL(site).origin) offOrigin.push(r.url());
      });
      await page.goto(`${site}/t/plots`);
      await page.waitForSelector("#summary", { timeout: 60000 });
      const summary = await page.textContent("#summary");
      assert(summary?.includes("60 points"), `summary: ${summary}`);
      await page.waitForSelector("svg circle", { timeout: 30000 });
      const dots = await page.$$eval("svg circle", (c: Element[]) => c.length);
      assert(dots === 60, `Plot drew ${dots} dots`);
      const nav = await page.$$eval(".site-nav a", (a: Element[]) => a.map((x) => x.textContent));
      assert(nav.length === 3, `navigation: ${nav}`);
      assert(errors.length === 0, `page errors: ${errors.join("; ")}`);
      // notebook-kit's built-ins (Inputs, htl) come from the site's module server, not esm.sh
      assert(offOrigin.length === 0, `off-origin requests: ${offOrigin.join("; ")}`);
      // Search from the header: "answer" is in the features notebook's prose.
      const hits = await searchFor(page, "answer");
      assert(
        /^\/nb\/demo\/t\/features(#|$)/.test(hits[0] ?? ""),
        `search results: ${hits.join(", ")}`,
      );
      await page.click(".search-results a");
      await page.waitForURL(/\/nb\/demo\/t\/features(#.*)?$/, { timeout: 15000 });
      return `Plot drew 60 dots in the themed page, no request off the platform; navigation: ${nav.join(", ")}; search "answer" led to features`;
    } finally {
      await b.close();
    }
  });
}

/** Types `query` into the themed page's search box and returns the result links' hrefs. */
// biome-ignore lint/suspicious/noExplicitAny: Playwright is untyped here
async function searchFor(page: any, query: string): Promise<string[]> {
  await page.fill(".site-search input", query);
  await page.waitForSelector(".search-results:not([hidden]) li", { timeout: 15000 });
  return page.$$eval(".search-results a", (a: Element[]) => a.map((x) => x.getAttribute("href")));
}

/** A static file server over `dir`: a directory answers with its index.html. */
function staticServer(dir: string) {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".woff2": "font/woff2",
  };
  const server = createServer((req, res) => {
    let file = join(dir, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise<{ url: string; close: () => void }>((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => server.close(),
      }),
    ),
  );
}

async function exportDemo(host: string, site: string, t: Tools) {
  const { check, browserOn, playwright } = t;
  const assert: Tools["assert"] = t.assert;
  let out = "";
  const exported = await check(
    host,
    "notebooks: the themed site exported as static files",
    async () => {
      const res = await fetch(`${site}/export`, { method: "POST" });
      const bytes = new Uint8Array(await res.arrayBuffer());
      assert(res.ok, `export ${res.status}: ${new TextDecoder().decode(bytes).slice(0, 300)}`);
      assert(res.headers.get("content-type") === "application/zip", "not a ZIP");
      const files = await unzip(bytes);
      // unzip names entries as absolute paths in the archive's tree
      for (const p of [
        "/index.html",
        "/nb/demo/t/index.html",
        "/nb/demo/t/plots/index.html",
        "/nb/demo/search.json",
        "/nb/demo/t/numbers.json",
      ])
        assert(files.has(p), `${p} missing from the export`);
      const models = (await (await fetch(`${site}/models.json`)).json()) as {
        pins: Record<string, string>;
      };
      for (const url of Object.values(models.pins))
        assert(files.has(url), `module ${url} missing from the export`);
      out = mkdtempSync(join(tmpdir(), "webrun-notebooks-export-"));
      for (const [p, b] of files) {
        mkdirSync(dirname(join(out, p)), { recursive: true });
        writeFileSync(join(out, p), b);
      }
      const builtins = res.headers.get("x-export-builtins") ?? "";
      assert(builtins.split(",").includes("Inputs"), `built-ins in the export: ${builtins}`);
      return `${res.headers.get("x-export-pages")} pages, ${res.headers.get("x-export-modules")} module files (built-ins: ${builtins}), ${(bytes.length / 1e6).toFixed(1)} MB`;
    },
  );
  if (!exported || !browserOn) return;
  await check(
    host,
    "notebooks: the exported site's cells run in Chromium, from files",
    async () => {
      const files = await staticServer(out);
      const b = await playwright().chromium.launch(chromiumOptions());
      try {
        const page = await b.newPage();
        const errors: string[] = [];
        const offOrigin: string[] = [];
        const missing: string[] = [];
        page.on("pageerror", (e: Error) => errors.push(e.message));
        page.on("request", (r: { url(): string }) => {
          if (!r.url().startsWith(files.url)) offOrigin.push(r.url());
        });
        page.on("response", (r: { url(): string; status(): number }) => {
          // a browser asks for /favicon.ico on its own; the export has none
          if (r.status() >= 400 && !r.url().endsWith("/favicon.ico"))
            missing.push(`${r.status()} ${r.url()}`);
        });
        await page.goto(`${files.url}/`); // the root's index.html redirects to the home page
        await page.waitForURL(`${files.url}/nb/demo/t/`, { timeout: 15000 });
        await page.click('.site-nav a[href="/nb/demo/t/plots"]');
        await page.waitForSelector("#summary", { timeout: 60000 });
        const summary = await page.textContent("#summary");
        assert(summary?.includes("60 points"), `summary: ${summary}`);
        await page.waitForSelector("svg circle", { timeout: 30000 });
        const dots = await page.$$eval("svg circle", (c: Element[]) => c.length);
        assert(dots === 60, `Plot drew ${dots} dots`);
        assert(errors.length === 0, `page errors: ${errors.join("; ")}`);
        assert(missing.length === 0, `failed loads: ${missing.join("; ")}`);
        // Nothing leaves the file server, notebook-kit's built-ins (Inputs, htl) included: the
        // site serves them, and the export carries the ones its cells use.
        assert(offOrigin.length === 0, `off-origin requests: ${offOrigin.join("; ")}`);
        // The data loader's output, from the files: FileAttachment on the features page.
        await page.goto(`${files.url}/nb/demo/t/features/`);
        await page.waitForFunction(
          () => document.body.textContent?.includes("10 numbers, summing to 55"),
          null,
          { timeout: 30000 },
        );
        // Search works from the files too: the export carries search.json.
        const hits = await searchFor(page, "answer");
        assert(
          /^\/nb\/demo\/t\/features(#|$)/.test(hits[0] ?? ""),
          `search results in the export: ${hits.join(", ")}`,
        );
        return "root redirected home, navigation led to plots, Plot drew 60 dots, the loader's data on features, search found features; no request left the file server";
      } finally {
        await b.close();
        files.close();
      }
    },
  );
}
