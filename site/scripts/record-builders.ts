/**
 * Records the results the /builders pages show: it starts the platform (packages/platform) on
 * CellB in Node, runs each page's example against it, as the page's usage code does, and writes
 * what the platform answered, and screenshots of what the examples produced:
 *
 *   src/builders/recorded/<kind>.json    the requests and answers (src/builders/types.ts)
 *   public/builders/<kind>*.png          the pages, in Chromium
 *
 *   pnpm --filter @statewalker/cellb-site record:builders [esm-cdn|user-code|bundler|astro|notebooks …]
 *
 * The platform listens on port 8787 (Wrangler's default, the port the pages' code uses), so stop
 * anything else there first. It needs the platform built (`pnpm --filter
 * @statewalker/cellb-platform build`, run here when dist/ is missing), network access to the npm
 * registry, and a Chromium for Playwright (`PW_CHROMIUM` names a binary). Each run starts from
 * empty storage, so the timings of first requests include the downloads from npm.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromiumOptions } from "../../packages/platform/scripts/chromium.ts";
import { startHost } from "../../packages/platform/scripts/hosts.mjs";
// The platform's own helpers, from the workspace (this script runs through tsx).
import { readTree } from "../../packages/platform-core/src/tree.ts";
import { unzip, zip } from "../../packages/platform-core/src/util.ts";
import type { Recorded, RecordedShot, RecordedStep } from "../src/builders/types.ts";

const site = resolve(import.meta.dirname, "..");
const repo = resolve(site, "..");
const platformDir = join(repo, "packages/platform");
const examples = join(site, "src/builders/examples");
const recordedDir = join(site, "src/builders/recorded");
const shotsDir = join(site, "public/builders");

const PORT = 8787;
const BASE = `http://localhost:${PORT}`;
const APP_PORT = 8788;
const APP = `http://localhost:${APP_PORT}`;
const PAGE_PORT = 8790;

const ASTRO_PIN = "7.4.4";
const KINDS = ["esm-cdn", "user-code", "bundler", "astro", "notebooks"] as const;
type Kind = (typeof KINDS)[number];
const wanted = process.argv.slice(2) as Kind[];
for (const k of wanted) if (!KINDS.includes(k)) throw new Error(`unknown kind ${k}: ${KINDS}`);
const kinds = wanted.length ? wanted : [...KINDS];

// --- recording -------------------------------------------------------------------------------

const KEEP_HEADERS = [
  "location",
  "content-type",
  "cache-control",
  "content-encoding",
  "etag",
  "access-control-allow-origin",
];

/** JSON with long arrays and strings cut, so a page can show it whole. */
function trimJson(v: unknown, maxItems = 12, maxString = 160): unknown {
  if (typeof v === "string")
    return v.length > maxString ? `${v.slice(0, maxString)}… (${v.length} chars)` : v;
  if (Array.isArray(v)) {
    const head = v.slice(0, maxItems).map((x) => trimJson(x, maxItems, maxString));
    return v.length > maxItems ? [...head, `… ${v.length - maxItems} more`] : head;
  }
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, trimJson(x, maxItems, maxString)]),
    );
  return v;
}

/** The first lines of a text, each cut to a readable width. */
function trimText(text: string, maxLines: number, comment = "//"): string {
  const lines = text.replace(/^\s*\n/, "").split("\n");
  const head = lines
    .slice(0, maxLines)
    .map((l) => (l.length > 140 ? `${l.slice(0, 140)}…` : l))
    .join("\n");
  const rest = lines.length - maxLines;
  return rest > 0 ? `${head}\n${comment} … ${rest} more lines` : head;
}

interface CallOptions {
  method?: string;
  body?: BodyInit;
  /** How the request body is described on the page. */
  bodyNote?: string;
  headers?: Record<string, string>;
  curl: string;
  title: string;
  note?: string;
  /** How many lines of a text body to keep (default 24). */
  lines?: number;
  maxItems?: number;
  /** Replace the recorded body text (e.g. to show only the part a page talks about). */
  show?: (text: string) => string;
}

class Recorder {
  steps: RecordedStep[] = [];
  shots: RecordedShot[] = [];
  facts: Record<string, string | number> = {};
  constructor(readonly kind: Kind) {}

  async call(url: string, o: CallOptions) {
    const method = o.method ?? "GET";
    const t = performance.now();
    const res = await fetch(url, { method, body: o.body, headers: o.headers, redirect: "manual" });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const ms = Math.round(performance.now() - t);
    const type = res.headers.get("content-type") ?? "";
    const text = new TextDecoder().decode(bytes);
    let body = "";
    let bodyLang = "txt";
    if (type.includes("json")) {
      bodyLang = "json";
      body = JSON.stringify(trimJson(JSON.parse(text), o.maxItems), null, 2);
    } else if (type.includes("javascript")) {
      bodyLang = "js";
      body = trimText(text, o.lines ?? 24);
    } else if (type.includes("html")) {
      bodyLang = "html";
      // Minified HTML (Astro's) gets a line per tag, so its excerpt shows the structure.
      const lined = text.split("\n").length < 5 ? text.replace(/></g, ">\n<") : text;
      body = trimText(lined, o.lines ?? 24, "<!--");
      if (body.endsWith("lines")) body += " -->";
    } else if (type.includes("css")) {
      bodyLang = "css";
      body = trimText(text, o.lines ?? 24, "/*");
      if (body.endsWith("lines")) body += " */";
    } else if (type.startsWith("text/") || (!type && bytes.length < 4096)) {
      body = trimText(text, o.lines ?? 24, "");
    } else body = `(${type || "binary"}, ${bytes.length} bytes)`;
    if (o.show) body = o.show(text);
    const headers: Record<string, string> = {};
    for (const h of KEEP_HEADERS) {
      const v = res.headers.get(h);
      if (v) headers[h] = v;
    }
    this.steps.push({
      title: o.title,
      note: o.note,
      curl: o.curl,
      request: { method, url, body: o.bodyNote },
      response: { status: res.status, headers, body, bodyLang, bytes: bytes.length, ms },
    });
    console.log(`  ${res.status} ${method} ${url} (${bytes.length} B, ${ms} ms)`);
    return { res, text, bytes, json: () => JSON.parse(text) };
  }

  save() {
    const out: Recorded = {
      kind: this.kind,
      recordedAt: new Date().toISOString().slice(0, 10),
      host: "the platform on CellB in Node (packages/platform, dist/platform/cellb)",
      steps: this.steps,
      shots: this.shots,
      facts: this.facts,
    };
    mkdirSync(recordedDir, { recursive: true });
    writeFileSync(join(recordedDir, `${this.kind}.json`), `${JSON.stringify(out, null, 2)}\n`);
    console.log(`  → src/builders/recorded/${this.kind}.json`);
  }
}

/** A CSS module: its long string literal cut, the code around it kept. */
function cssModule(t: string): string {
  const m = t.match(/^(const css = )("(?:[^"\\]|\\.)*");/);
  if (!m) return trimText(t, 20);
  const value = JSON.parse(m[2]) as string;
  const cut = JSON.stringify(value.slice(0, 220));
  return `${m[1]}${cut.slice(0, -1)}…" /* ${value.length} chars */;${t.slice(m[0].length)}`;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** A project's files as the JSON body of an import: `{ files: { path: text } }`. */
const filesJson = (dir: string) => {
  const files: Record<string, string> = {};
  for (const [p, b] of readTree(dir)) files[p.slice(1)] = new TextDecoder().decode(b);
  return files;
};

// --- the browser -------------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: Playwright is untyped here
type Page = any;
// biome-ignore lint/suspicious/noExplicitAny: Playwright is untyped here
let browser: any;
async function withPage<T>(fn: (page: Page, errors: string[]) => Promise<T>): Promise<T> {
  if (!browser) {
    const { chromium } = createRequire(import.meta.url)("playwright");
    browser = await chromium.launch(chromiumOptions());
  }
  const context = await browser.newContext({
    viewport: { width: 800, height: 360 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  try {
    return await fn(page, errors);
  } finally {
    await context.close();
  }
}

async function shoot(page: Page, name: string) {
  mkdirSync(shotsDir, { recursive: true });
  const file = join(shotsDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  // A PNG's IHDR chunk: width and height, big-endian, at bytes 16 and 20.
  const png = readFileSync(file);
  return {
    src: `/builders/${name}.png`,
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

/** Serves one HTML file on PAGE_PORT, for a page that is not served by the platform. */
function servePage(html: string): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((ok) => server.listen(PAGE_PORT, "127.0.0.1", () => ok(server)));
}

/** Unpacks a build's project.zip into a temporary folder and starts it on CellB in Node. */
async function runBuild(id: string) {
  const z = await fetch(`${BASE}/b/${id}/project.zip`);
  assert(z.ok, `project.zip ${z.status}`);
  const out = mkdtempSync(join(tmpdir(), `builders-${id}-`));
  for (const [p, b] of await unzip(new Uint8Array(await z.arrayBuffer()))) {
    mkdirSync(dirname(join(out, p)), { recursive: true });
    writeFileSync(join(out, p), b);
  }
  return startHost("cellb", out, { port: APP_PORT });
}

// --- the examples --------------------------------------------------------------------------------

async function esmCdn(r: Recorder) {
  const plot = await r.call(`${BASE}/npm/browser/@observablehq/plot@0.6`, {
    title: "A version range redirects to a pinned version",
    note: "The CDN reads the package's packument from the package store (which fetched it from npm) and picks the highest version in the range.",
    curl: `curl -i ${BASE}/npm/browser/@observablehq/plot@0.6`,
  });
  const pinned = plot.res.headers.get("location") ?? "";
  assert(plot.res.status === 302 && pinned, `expected a redirect, got ${plot.res.status}`);
  r.facts.plotPinned = pinned;
  const cold = await r.call(`${BASE}${pinned}`, {
    title: "The pinned URL is the module, as ESM",
    note: "First request: the tarball is downloaded into the package store and the file transformed. Bare imports are rewritten to same-origin URLs; the answer is immutable.",
    curl: `curl -i ${BASE}${pinned}`,
    lines: 18,
  });
  const warm = await r.call(`${BASE}${pinned}`, {
    title: "The same URL again",
    note: "Second request: the transformed module comes from the object's SQLite.",
    curl: `curl -s -o /dev/null -w '%{time_total}s' ${BASE}${pinned}`,
    show: () => "(the same 200 answer, from the cache)",
  });
  r.facts.coldMs = r.steps.at(-2)?.response.ms ?? 0;
  r.facts.warmMs = r.steps.at(-1)?.response.ms ?? 0;
  assert(cold.text === warm.text, "the cached module differs");

  const graph = await r.call(`${BASE}/npm/browser/@observablehq/plot@0.6?graph`, {
    title: "?graph lists every module an entry needs",
    note: "A page can put these in <link rel=modulepreload> and load the whole graph in one round of requests.",
    curl: `curl '${BASE}/npm/browser/@observablehq/plot@0.6?graph'`,
    maxItems: 10,
  });
  r.facts.plotModules = graph.json().length;
  await r.call(`${BASE}/npm/browser/d3-dsv@3?meta`, {
    title: "?meta lists a package's files",
    curl: `curl -L '${BASE}/npm/browser/d3-dsv@3?meta'`,
    maxItems: 8,
  });
  // ?meta on a range redirects first; record the pinned answer.
  const dsvMeta = r.steps.at(-1);
  if (dsvMeta?.response.status === 302) {
    const loc = dsvMeta.response.headers.location;
    r.steps.pop();
    await r.call(`${BASE}${loc}`, {
      title: "?meta lists a package's files",
      note: "On a range it redirects to the pinned version first, like any CDN URL (curl -L follows).",
      curl: `curl -L '${BASE}/npm/browser/d3-dsv@3?meta'`,
      maxItems: 8,
    });
  }
  const css = await r.call(`${BASE}/npm/browser/@picocss/pico@2/css/pico.min.css?module`, {
    title: "A stylesheet as a module",
    note: '?module answers CSS with a module that adds it to the document, so `import "…css?module"` works in a page. Lightning CSS processes it first.',
    curl: `curl -L '${BASE}/npm/browser/@picocss/pico@2/css/pico.min.css?module'`,
    show: cssModule,
  });
  if (css.res.status === 302) {
    r.steps.pop();
    await r.call(`${BASE}${css.res.headers.get("location")}`, {
      title: "A stylesheet as a module",
      note: '?module answers CSS with a module that adds it to the document, so `import "…css?module"` works in a page. Lightning CSS processes it first.',
      curl: `curl -L '${BASE}/npm/browser/@picocss/pico@2/css/pico.min.css?module'`,
      show: cssModule,
    });
  }
  for (const profile of ["browser", "node"]) {
    const redirect = await fetch(`${BASE}/npm/${profile}/nanoid@5`, { redirect: "manual" });
    const loc = redirect.headers.get("location") ?? "";
    await r.call(`${BASE}${loc}`, {
      title: `The ${profile} profile: nanoid`,
      note:
        profile === "browser"
          ? "/npm/browser/ resolves with the browser conditions: nanoid's browser build, which uses crypto.getRandomValues."
          : "/npm/node/ resolves with the node conditions: nanoid's Node build, whose node:crypto import is left for the runtime (a Worker with nodejs_compat, Deno, Node).",
      curl: `curl -L ${BASE}/npm/${profile}/nanoid@5`,
      lines: 10,
    });
  }

  const html = readFileSync(join(examples, "esm-cdn/index.html"), "utf8");
  const server = await servePage(html);
  try {
    await withPage(async (page, errors) => {
      const modules = new Set<string>();
      page.on("request", (req: { url(): string }) => {
        if (req.url().startsWith(`${BASE}/npm/`)) modules.add(req.url());
      });
      await page.goto(`http://localhost:${PAGE_PORT}/`);
      await page.waitForSelector("#chart svg", { timeout: 60_000 });
      const bars = await page.$$eval("#chart svg rect", (e: Element[]) => e.length);
      const note = await page.textContent("#note");
      assert(errors.length === 0, `page errors: ${errors.join("; ")}`);
      assert(bars === 12, `${bars} bars`);
      r.facts.pageModules = modules.size;
      r.shots.push({
        ...(await shoot(page, "esm-cdn")),
        alt: "A bar chart of rainfall by month, styled by Pico CSS, drawn by Observable Plot",
        caption: `index.html in Chromium: ${note}`,
        checks: [
          `${modules.size} module requests to the CDN, all answered`,
          `${bars} bars drawn, no page errors`,
          "Pico CSS applied through the ?module stylesheet",
        ],
      });
    });
  } finally {
    server.close();
  }
}

async function userCode(r: Recorder) {
  const dir = join(examples, "user-code");
  const files = filesJson(dir);
  await r.call(`${BASE}/p/tasks/import`, {
    method: "POST",
    title: "Write the project's files",
    note: "The working tree replaces whatever the project held. A ZIP works too; single files go with PUT /p/tasks/files/<path>.",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files }),
    bodyNote: `{ "files": { ${Object.keys(files)
      .map((p) => `"${p}": "…"`)
      .join(", ")} } }`,
    curl: `node -e 'const fs=require("fs");const files={};for(const p of process.argv.slice(1))files[p]=fs.readFileSync(p,"utf8");console.log(JSON.stringify({files}))' index.html package.json src/* \\
  | curl -X POST -H 'content-type: application/json' --data-binary @- ${BASE}/p/tasks/import`,
  });
  const snap = await r.call(`${BASE}/p/tasks/snapshots`, {
    method: "POST",
    title: "Take a snapshot",
    note: "The snapshot id is the hash of the tree. Everything under its base URL is immutable.",
    curl: `curl -X POST ${BASE}/p/tasks/snapshots`,
  });
  const { snapshot, base } = snap.json() as { snapshot: string; base: string };
  const baseUrl = new URL(base, BASE).href;
  r.facts.snapshot = snapshot;
  r.facts.base = new URL(base, BASE).pathname;
  await r.call(`${baseUrl}~/src/App.tsx`, {
    title: "A TSX file, served as ESM",
    note: "Types are stripped and JSX compiled with the automatic runtime. Every import is now a URL: the project's own files stay under the snapshot, npm packages go to the CDN's pinned URLs (through the snapshot's ~deps proxy) at the ranges in package.json.",
    curl: `curl ${r.facts.base}~/src/App.tsx`.replace(/^curl \//, `curl ${BASE}/`),
    lines: 30,
  });
  await r.call(`${baseUrl}~/src/styles.css?module`, {
    title: "CSS, as a module",
    note: "Nested CSS is lowered by Lightning CSS for the browsers it targets.",
    curl: `curl '${BASE}${r.facts.base}~/src/styles.css?module'`,
    show: cssModule,
  });
  const resolved = await r.call(`${baseUrl}resolve`, {
    method: "POST",
    title: "Resolve the entry points",
    note: "The URL of each entry and the project modules to preload.",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entries: ["src/main.tsx"] }),
    bodyNote: `{ "entries": ["src/main.tsx"] }`,
    curl: `curl -X POST -d '{"entries":["src/main.tsx"]}' ${BASE}${r.facts.base}resolve`,
  });
  r.facts.preload = (resolved.json() as { preload: string[] }).preload.length;

  await withPage(async (page, errors) => {
    const urls = new Set<string>();
    page.on("request", (req: { url(): string }) => urls.add(req.url()));
    await page.goto(`${baseUrl}~/index.html`);
    await page.waitForSelector(".summary", { timeout: 60_000 });
    await page.click("li:first-child input[type=checkbox]");
    await page.fill("form input", "Edit a file, snapshot again");
    await page.click("form button");
    await page.waitForSelector("text=1 of 4 done");
    const summary = await page.textContent(".summary");
    const color = await page.$eval("h1", (e: Element) => getComputedStyle(e).color);
    assert(errors.length === 0, `page errors: ${errors.join("; ")}`);
    assert(color === "rgb(124, 58, 237)", `styles.css not applied: ${color}`);
    const project = [...urls].filter((u) => u.includes("/p/tasks/")).length;
    const cdn = [...urls].filter((u) => u.includes("/npm/")).length;
    r.facts.pageRequests = urls.size;
    r.shots.push({
      ...(await shoot(page, "user-code")),
      alt: "The Tasks app: four tasks, the first checked, summary 1 of 4 done",
      caption: `${r.facts.base}~/index.html in Chromium, after a click and a new task: "${summary}"`,
      checks: [
        `${project} requests for the project's modules, ${cdn} for npm modules from the CDN`,
        "TSX compiled, React rendered, nanoid made the ids",
        "styles.css applied (the heading is violet), no page errors",
      ],
    });
  });

  const edited = files["src/main.tsx"].replace('title="Tasks"', 'title="Tasks, edited"');
  await r.call(`${BASE}/p/tasks/files/src/main.tsx`, {
    method: "PUT",
    title: "Edit one file",
    body: edited,
    bodyNote: `src/main.tsx, with title="Tasks, edited"`,
    curl: `curl -X PUT --data-binary @src/main.tsx ${BASE}/p/tasks/files/src/main.tsx`,
  });
  const snap2 = await r.call(`${BASE}/p/tasks/snapshots`, {
    method: "POST",
    title: "Snapshot again: a new id",
    note: "Only the changed file is transformed again when it is requested; the old snapshot still serves the old file, so an open page never mixes versions.",
    curl: `curl -X POST ${BASE}/p/tasks/snapshots`,
  });
  r.facts.snapshot2 = (snap2.json() as { snapshot: string }).snapshot;
  assert(r.facts.snapshot2 !== snapshot, "the edit did not change the snapshot");
  const old = await fetch(`${baseUrl}~/src/main.tsx`).then((x) => x.text());
  assert(old.includes('"Tasks"') && !old.includes("edited"), "the old snapshot changed");
}

async function bundler(r: Recorder) {
  const dir = join(examples, "bundler");
  const tree = readTree(dir);
  const body = zip([...tree]);
  const first = await r.call(`${BASE}/builds`, {
    method: "POST",
    title: "Send the project as a ZIP",
    note: "The build runs in its BuildJob object, with esbuild-wasm. hono is not in the ZIP: it comes from the package store at the range package.json declares.",
    body: body as BodyInit,
    bodyNote: `a ZIP of ${tree.size} files (${(body.length / 1024).toFixed(1)} KiB): ${[...tree.keys()].map((p) => p.slice(1)).join(", ")}`,
    curl: `zip -r - . | curl -X POST --data-binary @- ${BASE}/builds`,
    maxItems: 20,
  });
  const s = first.json() as { id: string; status: string; stats?: Record<string, unknown> };
  assert(s.status === "done", `build ${s.status}: ${first.text.slice(0, 500)}`);
  const id = s.id;
  r.facts.buildId = id;
  r.facts.buildMs = r.steps.at(-1)?.response.ms ?? 0;
  await r.call(`${BASE}/b/${id}/`, {
    title: "The output's files",
    curl: `curl ${BASE}/b/${id}/`,
  });
  await r.call(`${BASE}/b/${id}/wrangler.json`, {
    title: "wrangler.json: a no_bundle project",
    note: "main is the one bundled module; the Durable Object binding and migration are kept; assets point at the copied folder.",
    curl: `curl ${BASE}/b/${id}/wrangler.json`,
  });
  const worker = await r.call(`${BASE}/b/${id}/worker.js`, {
    title: "worker.js: the project and hono in one module",
    note: "cloudflare:workers stays an import, for the host to provide. The host-compatibility entry wraps the default export.",
    curl: `curl ${BASE}/b/${id}/worker.js`,
    lines: 14,
  });
  r.facts.workerBytes = worker.bytes.length;
  await r.call(`${BASE}/b/${id}/loader.json`, {
    title: "loader.json: the same build as a Worker Loader payload",
    note: "What env.LOADER.get(id, () => payload) takes: a host Worker can run the build by id, with no deploy.",
    curl: `curl ${BASE}/b/${id}/loader.json`,
    show: (t) => {
      const p = JSON.parse(t) as { modules: Record<string, unknown> } & Record<string, unknown>;
      const modules = Object.fromEntries(
        Object.entries(p.modules).map(([k, v]) => [
          k,
          `… ${typeof v === "string" ? v.length : JSON.stringify(v).length} chars`,
        ]),
      );
      return JSON.stringify({ ...p, modules }, null, 2);
    },
  });
  await r.call(`${BASE}/builds`, {
    method: "POST",
    title: "The same inputs again",
    note: "A build id is the hash of the builder version, the inputs and the spec: the finished build is returned, not made again.",
    body: body as BodyInit,
    bodyNote: "the same ZIP",
    curl: `zip -r - . | curl -X POST --data-binary @- ${BASE}/builds`,
    show: (t) => {
      const j = JSON.parse(t) as { id: string; status: string };
      return JSON.stringify({ id: j.id, status: j.status, "…": "as above" }, null, 2);
    },
  });

  const app = await runBuild(id);
  try {
    await r.call(`${APP}/`, {
      title: "Run the output: the static page",
      note: "project.zip, unpacked and started on CellB in Node (wrangler dev and celld dev run the same folder).",
      curl: `curl -o build.zip ${BASE}/b/${id}/project.zip && unzip build.zip -d build\nnpx tsx packages/platform/scripts/serve-cellb.mjs build --port ${APP_PORT}\ncurl ${APP}/`,
    });
    for (const [name, text] of [
      ["Ada", "First!"],
      ["Grace", "Hello from a Durable Object."],
    ])
      await r.call(`${APP}/api/rooms/lobby`, {
        method: "POST",
        title: `Sign the lobby's guestbook (${name})`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, text }),
        bodyNote: JSON.stringify({ name, text }),
        curl: `curl -X POST -d '${JSON.stringify({ name, text })}' ${APP}/api/rooms/lobby`,
      });
    await r.call(`${APP}/api/rooms/kitchen`, {
      title: "Another room is another object",
      note: "getByName('kitchen') is a different Durable Object with its own, empty database.",
      curl: `curl ${APP}/api/rooms/kitchen`,
    });
  } finally {
    await app.stop();
  }
}

async function astro(r: Recorder) {
  const dir = join(repo, "examples/platform-astro");
  const tree = readTree(dir, dir, ["dist", "scripts"]);
  // astro 7.4.10 (2026-11-10) no longer ships the prebuilt client directives the Astro builder
  // imports (astro/runtime/client/*.prebuilt.js), so the build pins the version of the examples'
  // lockfile until the builder follows.
  const pkg = JSON.parse(new TextDecoder().decode(tree.get("/package.json")));
  pkg.dependencies.astro = ASTRO_PIN;
  tree.set("/package.json", new TextEncoder().encode(`${JSON.stringify(pkg, null, 2)}\n`));
  r.facts.astroPin = ASTRO_PIN;
  const body = zip([...tree]);
  const build = await r.call(`${BASE}/builds?sourcemap=0`, {
    method: "POST",
    title: "Send the Astro project's sources",
    note: "The project has an astro.config.mjs, so the bundler builds it with the Astro builder first: the config and its integrations run, the .astro files are compiled by compiler-rs, the server and client bundles are made, then the server entry is bundled into one Worker like any project. No node_modules and no dist/ are sent.",
    body: body as BodyInit,
    bodyNote: `a ZIP of ${tree.size} files (${(body.length / 1024).toFixed(1)} KiB): ${[...tree.keys()].map((p) => p.slice(1)).join(", ")}`,
    curl: `zip -r - . -x 'node_modules/*' 'dist/*' | curl -X POST --data-binary @- '${BASE}/builds?sourcemap=0'`,
    maxItems: 30,
  });
  const s = build.json() as { id: string; status: string; stats?: Record<string, unknown> };
  assert(s.status === "done", `build ${s.status}: ${build.text.slice(0, 1500)}`);
  r.facts.buildId = s.id;
  r.facts.buildMs = r.steps.at(-1)?.response.ms ?? 0;
  await r.call(`${BASE}/b/${s.id}/`, {
    title: "The output: a Worker and its client assets",
    curl: `curl ${BASE}/b/${s.id}/`,
    maxItems: 30,
  });
  await r.call(`${BASE}/b/${s.id}/wrangler.json`, {
    title: "wrangler.json",
    note: "The project's Durable Object, plus what Astro's Cloudflare adapter adds: the assets binding and a SESSION KV namespace (with a stable id, which celld requires).",
    curl: `curl ${BASE}/b/${s.id}/wrangler.json`,
  });

  const app = await runBuild(s.id);
  try {
    await r.call(`${APP}/`, {
      title: "Run the output: the home page, rendered on the server",
      note: "The page reads the visit count from the Visits Durable Object before it renders. The <astro-island> holds the React counter.",
      curl: `curl ${APP}/`,
      lines: 40,
    });
    await r.call(`${APP}/posts/islands`, {
      title: "A dynamic route",
      curl: `curl ${APP}/posts/islands`,
    });
    await r.call(`${APP}/api/time`, {
      title: "An API route",
      curl: `curl ${APP}/api/time`,
    });
    await withPage(async (page, errors) => {
      await page.goto(`${APP}/`);
      await page.waitForFunction(
        () => document.querySelector("astro-island:not([ssr])") !== null,
        null,
        { timeout: 30_000 },
      );
      await page.click("#island");
      await page.click("#island");
      await page.click("#island");
      await page.waitForSelector("text=island clicks: 3");
      const visits = await page.textContent("#visits");
      assert(errors.length === 0, `page errors: ${errors.join("; ")}`);
      r.shots.push({
        ...(await shoot(page, "astro")),
        alt: "The Astro app's home page: a heading, the visit count, three post links and the island button after three clicks",
        caption: `${APP}/ in Chromium, served by the build on CellB in Node: "${visits}", the island clicked three times`,
        checks: [
          "the server rendered the page and counted the visit in the Durable Object",
          "the React island hydrated (client:load) and counts clicks",
          "no page errors",
        ],
      });
    });
  } finally {
    await app.stop();
  }
}

async function notebooks(r: Recorder) {
  const dir = join(repo, "examples/platform-demos/notebooks");
  const files = filesJson(dir);
  const site = `${BASE}/nb/demo`;
  await r.call(`${site}/import`, {
    method: "POST",
    title: "Send the notebooks",
    note: "A Markdown notebook and an Observable Notebook Kit document. They go to the NotebookSite object named demo.",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files }),
    bodyNote: `{ "files": { ${Object.keys(files)
      .map((p) => `"${p}": "…"`)
      .join(", ")} } }`,
    curl: `node -e 'const fs=require("fs");const files={};for(const p of process.argv.slice(1))files[p]=fs.readFileSync(p,"utf8");console.log(JSON.stringify({files}))' index.md plots.html \\
  | curl -X POST -H 'content-type: application/json' --data-binary @- ${site}/import`,
  });
  const built = await r.call(`${site}/build`, {
    method: "POST",
    title: "Build the pages",
    note: "notebook-build compiles each notebook to a page, in the object, with linkedom as its DOM. The broken cell in index.md is not a failure: it renders as an error in place.",
    curl: `curl -X POST ${site}/build`,
  });
  const res = built.json() as { pages: string[]; failures: unknown[] };
  assert(res.failures.length === 0, `failures: ${JSON.stringify(res.failures)}`);
  r.facts.buildMs = r.steps.at(-1)?.response.ms ?? 0;
  await r.call(`${site}/plots.html`, {
    title: "A compiled page",
    note: "Each cell is a module the notebook runtime runs in dependency order. npm: imports point at the site's module server, under /nb/demo/_m/.",
    curl: `curl ${site}/plots.html`,
    lines: 40,
  });
  await r.call(`${site}/build`, {
    method: "POST",
    title: "Build again, nothing changed",
    note: "Builds are incremental: an unchanged notebook is not compiled again.",
    curl: `curl -X POST ${site}/build`,
  });

  await withPage(async (page, errors) => {
    await page.goto(`${site}/plots.html`);
    await page.waitForSelector("#summary", { timeout: 90_000 });
    await page.waitForSelector("svg circle", { timeout: 60_000 });
    const dots = await page.$$eval("svg circle", (c: Element[]) => c.length);
    await page.fill('input[type="number"]', "120");
    await page.press('input[type="number"]', "Enter");
    await page.waitForFunction(
      () => document.querySelector("#summary")?.textContent?.includes("120 points"),
      null,
      { timeout: 20_000 },
    );
    const dots2 = await page.$$eval("svg circle", (c: Element[]) => c.length);
    const summary = await page.textContent("#summary");
    assert(errors.length === 0, `page errors: ${errors.join("; ")}`);
    r.shots.push({
      ...(await shoot(page, "notebooks-plots")),
      alt: "The Observable notebook: a points slider at 120, a scatter plot with a moving-average line, and the summary",
      caption: `${site}/plots.html in Chromium, after the slider was set to 120: "${summary}"`,
      checks: [
        `Plot drew ${dots} dots; setting the input to 120 re-ran the cells that read it (${dots2} dots)`,
        "d3 and Observable Plot came from the site's module server",
        "no page errors",
      ],
    });
  });
  await withPage(async (page) => {
    await page.goto(`${site}/index.html`);
    await page.waitForSelector("svg", { timeout: 90_000 });
    await page.waitForFunction(() => document.querySelectorAll("svg").length >= 2, null, {
      timeout: 30_000,
    });
    const text = await page.textContent("body");
    assert(text?.includes("n is 24"), "the cell after the broken one did not run");
    r.shots.push({
      ...(await shoot(page, "notebooks-markdown")),
      alt: "The Markdown notebook: two plots of a sine wave, the broken cell's error, and the cell after it",
      caption: `${site}/index.html in Chromium: the Markdown notebook`,
      checks: [
        "both plots drawn",
        "the broken cell shows its syntax error in place",
        'the cell after it ran ("n is 24")',
      ],
    });
  });
}

// --- main ----------------------------------------------------------------------------------------

if (!existsSync(join(platformDir, "dist/platform/cellb/worker.js"))) {
  console.log("building the platform (packages/platform)…");
  execFileSync("pnpm", ["--filter", "@statewalker/cellb-platform", "build"], {
    stdio: "inherit",
    cwd: repo,
  });
}

console.log(`starting the platform on CellB in Node at ${BASE}…`);
const platform = await startHost("cellb", join(platformDir, "dist/platform/cellb"), { port: PORT });
const run: Record<Kind, (r: Recorder) => Promise<void>> = {
  "esm-cdn": esmCdn,
  "user-code": userCode,
  bundler,
  astro,
  notebooks,
};
let failed = false;
try {
  for (const kind of kinds) {
    console.log(`\n== ${kind}`);
    const r = new Recorder(kind);
    try {
      await run[kind](r);
      r.save();
    } catch (e) {
      failed = true;
      console.error(`FAILED ${kind}: ${(e as Error).stack ?? e}`);
    }
  }
} finally {
  await browser?.close();
  await platform.stop();
}
process.exit(failed ? 1 : 0);
