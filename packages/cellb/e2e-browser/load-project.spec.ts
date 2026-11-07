import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
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
async function load(page: import("@playwright/test").Page, url: string, runs: string[][]) {
  await page.goto("/load-project/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const data = `load-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const r = await page.evaluate((a) => (window as any).__loadProject(a), { url, data, runs });
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

test("Worker Loader code runs in the package's own isolate worker", async ({ page }) => {
  const url = await build("isolation-api", "conformance/projects/isolation-api");
  const golden = JSON.parse(
    readFileSync(join(PKG, "conformance/golden/isolation-api.json"), "utf8"),
  ).transcript;
  const r = await load(page, url, [["/"]]);
  expect(r.out[0][0].status).toBe(200);
  expect(JSON.parse(r.out[0][0].body)).toEqual(golden[0].body);
});
