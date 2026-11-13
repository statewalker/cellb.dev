import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { files as helloHono } from "../../../site/src/from-sources/project.ts";
import { buildProject } from "../src/project/build.ts";

// loadProject from @statewalker/cellb/browser (#67): `cellb build` writes a folder into the dev
// server's public/ directory, and a Dedicated Worker loads it by URL.
const PKG = resolve(import.meta.dirname, "..");
const PUBLIC = join(PKG, "e2e-browser/pages/public/built");

async function build(project: string, dir: string) {
  await buildProject(join(PKG, dir), join(PUBLIC, project));
  return `/built/${project}/`;
}

type Run = { status: number; type: string | null; body: string }[];
type Source = string | { sources: [string, string][]; compile?: "bundle" | "site" };
async function load(page: import("@playwright/test").Page, source: Source, runs: string[][]) {
  await page.goto("/load-project/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const data = `load-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const job = typeof source === "string" ? { url: source } : source;
  const r = await page.evaluate((a) => (window as any).__loadProject(a), { ...job, data, runs });
  expect(r.ok, r.error).toBe(true);
  return r as { name: string; unsupported: string[]; out: Run[] };
}

test("a built counter: cells kept in OPFS under `data` across loads", async ({ page }) => {
  const url = await build("counter", "conformance/celld-examples/counter");
  const r = await load(page, url, [
    ["/?name=alpha", "/?name=alpha", "/?name=beta"],
    ["/?name=alpha"],
  ]);
  expect(r.name).toBe("counter");
  expect(r.unsupported).toEqual([]);
  const n = (run: Run) => run.map((x) => JSON.parse(x.body).n);
  expect(n(r.out[0])).toEqual([1, 2, 1]);
  expect(n(r.out[1])).toEqual([3]);
});

test("a built project with assets answers as celld does", async ({ page }) => {
  const url = await build("assets-api", "conformance/projects/assets-api");
  const golden = JSON.parse(
    readFileSync(join(PKG, "conformance/golden/assets-api.json"), "utf8"),
  ).transcript.filter((s: { request?: string }) => s.request?.startsWith("GET "));
  const paths = [...new Set<string>(golden.map((s: { request: string }) => s.request.slice(4)))]
    .filter((p) => !p.includes(" "))
    .slice(0, 6);
  const r = await load(page, url, [paths]);
  for (const [i, path] of paths.entries()) {
    const want = golden.find((s: { request: string }) => s.request === `GET ${path}`);
    expect(r.out[0][i].status, path).toBe(want.status);
  }
});

test("a built project importing .wasm, Text and Data files", async ({ page }) => {
  const url = await build("wasm-modules", "test/fixtures/wasm-modules");
  const r = await load(page, url, [["/?a=2&b=40"]]);
  expect(r.out[0][0].status).toBe(200);
  expect(JSON.parse(r.out[0][0].body)).toEqual({
    sum: 42,
    module: true,
    sameModuleRule: 42,
    greeting: "hello from a Text rule\n",
    data: [1, 2, 3, 255],
  });
});

test("Worker Loader code runs in the package's own isolate worker", async ({ page }) => {
  const url = await build("isolation-api", "conformance/projects/isolation-api");
  const golden = JSON.parse(
    readFileSync(join(PKG, "conformance/golden/isolation-api.json"), "utf8"),
  ).transcript;
  const r = await load(page, url, [["/"]]);
  expect(r.out[0][0].status).toBe(200);
  expect(JSON.parse(r.out[0][0].body)).toEqual(golden[0].body);
});

test("a loaded Worker that replaces postMessage and location keeps answering from its isolate", async ({
  page,
}) => {
  const url = await build("isolate-globals", "e2e-browser/projects/isolate-globals");
  const r = await load(page, url, [["/"]]);
  expect(r.out[0][0].status).toBe(200);
  expect(JSON.parse(r.out[0][0].body)).toEqual({
    taken: "taken",
    pings: [
      { n: 1, href: "https://example.test/" },
      { n: 2, href: "https://example.test/" },
    ],
  });
});

// A project's sources in a FilesApi (#72), compiled in the browser: `bundle` (webrun-bundler on
// esbuild-wasm, one ES module) and `site` (modules served by the page's ServiceWorker).

/** A source folder's files, as the page sends them to the worker: path, base64. */
function sources(dir: string): [string, string][] {
  const root = join(PKG, dir);
  const out: [string, string][] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push([`/${relative(root, full)}`, readFileSync(full).toString("base64")]);
    }
  };
  walk(root);
  return out;
}

test("sources without `compile` are refused, naming it", async ({ page }) => {
  await page.goto("/load-project/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const r = await page.evaluate((a) => (window as any).__loadProject(a), {
    sources: sources("conformance/celld-examples/counter"),
    data: "unused",
    runs: [[]],
  });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("pass `compile` to load a source folder");
});

for (const compile of ["bundle", "site"] as const) {
  test.describe(`compile: ${compile}`, () => {
    test("a counter from its sources: cells kept in OPFS across loads", async ({ page }) => {
      const r = await load(
        page,
        { sources: sources("conformance/celld-examples/counter"), compile },
        [["/?name=alpha", "/?name=alpha", "/?name=beta"], ["/?name=alpha"]],
      );
      expect(r.name).toBe("counter");
      const n = (run: Run) => run.map((x) => JSON.parse(x.body).n);
      expect(n(r.out[0])).toEqual([1, 2, 1]);
      expect(n(r.out[1])).toEqual([3]);
    });

    test("a project with assets answers as its `cellb build` folder does", async ({ page }) => {
      const paths = ["/", "/about", "/api/x", "/via-binding", "/missing"];
      const url = await build(`assets-api-${compile}`, "conformance/projects/assets-api");
      const built = await load(page, url, [paths]);
      const r = await load(page, { sources: sources("conformance/projects/assets-api"), compile }, [
        paths,
      ]);
      for (const [i, path] of paths.entries())
        expect([r.out[0][i].status, r.out[0][i].body], path).toEqual([
          built.out[0][i].status,
          built.out[0][i].body,
        ]);
    });

    test("nodejs_compat answers as its `cellb build` folder does", async ({ page }) => {
      const url = await build(`node-compat-${compile}`, "conformance/projects/node-compat");
      const built = await load(page, url, [["/"]]);
      const r = await load(
        page,
        { sources: sources("conformance/projects/node-compat"), compile },
        [["/"]],
      );
      expect(r.out[0][0].status).toBe(200);
      // randomUUID and timings differ between runs: compare what is deterministic.
      const pick = (body: string) => {
        const { buffer, crypto, events, path } = JSON.parse(body);
        return { buffer, crypto, events, path };
      };
      expect(pick(r.out[0][0].body)).toEqual(pick(built.out[0][0].body));
    });
  });
}

test("the from-sources demo's Hono project, bundled with its npm packages", async ({ page }) => {
  test.setTimeout(120_000);
  // Its packages come from the npm registry: offline (a sandbox whose browser has no network),
  // test/p41-load-sources.test.ts covers the same bundle on Node.
  await page.goto("/load-project/");
  const online = await page.evaluate(() =>
    fetch("https://registry.npmjs.org/hono", { method: "HEAD" }).then(
      (r) => r.ok,
      () => false,
    ),
  );
  test.skip(!online, "the browser cannot reach registry.npmjs.org");
  const files = Object.entries(helloHono).map(
    ([path, text]) => [`/${path}`, Buffer.from(text).toString("base64")] as [string, string],
  );
  const r = await load(page, { sources: files, compile: "bundle" }, [
    ["/", "/hello/ada", "/hello/ada"],
  ]);
  expect(r.out[0][0].body).toBe("Try /hello/your-name");
  expect(r.out[0].slice(1).map((x) => JSON.parse(x.body).visits)).toEqual([1, 2]);
});
