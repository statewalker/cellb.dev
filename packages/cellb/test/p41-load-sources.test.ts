// loadProject from sources in browsers (#72): `bundleCompiler` (@statewalker/cellb/bundle) bundles
// a source folder with webrun-bundler on esbuild-wasm, as a browser does. Here esbuild-wasm runs
// on Node, and the bundle it makes runs on Node's loadProject (which takes a bundle made with
// cellbHostModule as a project's `main`), next to the project loaded from its own sources.
// e2e-browser/load-project.spec.ts runs the same compilers in a browser.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { bundleCompiler } from "@statewalker/cellb/bundle";
import { loadProject } from "@statewalker/cellb/node";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import * as esbuild from "esbuild-wasm";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { files as helloHono } from "../../../site/src/from-sources/project.js";
import { hasNodeCompat, readSourceProject } from "../src/project/source-project.js";

const PKG = resolve(import.meta.dirname, "..");
const COUNTER = join(PKG, "conformance/celld-examples/counter");
const ASSETS = join(PKG, "conformance/projects/assets-api");
const NODE_COMPAT = join(PKG, "conformance/projects/node-compat");

const req = (path: string) => new Request(`http://localhost${path}`);
const enc = new TextEncoder();
const opened: { close(): Promise<void> }[] = [];
const track = <T extends { close(): Promise<void> }>(p: T) => {
  opened.push(p);
  return p;
};
afterEach(async () => {
  for (const p of opened.splice(0)) await p.close();
});

beforeAll(async () => {
  await esbuild.initialize({});
});

/** A folder on disk, copied into a MemFilesApi (as a browser would hold it). */
async function inMemory(dir: string): Promise<MemFilesApi> {
  const files = new MemFilesApi();
  const walk = async (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) await walk(full);
      else await files.write(`/${relative(dir, full)}`, [new Uint8Array(readFileSync(full))]);
    }
  };
  await walk(dir);
  return files;
}

/**
 * Compiles a source folder with `bundleCompiler`, and gives it back as a source folder whose
 * `main` is the bundle (its assets as they were), for Node's loadProject.
 */
async function compiled(files: FilesApi): Promise<{ files: MemFilesApi; code: string }> {
  const project = await readSourceProject(files);
  if (!project) throw new Error("no wrangler config");
  const { config } = project;
  const out = await bundleCompiler({ esbuild }).compile({
    files,
    config,
    nodeCompat: hasNodeCompat(config),
  });
  if (!("bundle" in out.code) || out.code.bundle === null) throw new Error("no bundle");
  const code = out.code.bundle;
  const result = new MemFilesApi();
  await result.write("/worker.js", [enc.encode(code)]);
  const { assets: _assets, ...rest } = config;
  const wrangler = { ...rest, main: "worker.js" } as typeof config;
  if (config.assets) wrangler.assets = { ...config.assets, directory: "public" };
  await result.write("/wrangler.json", [enc.encode(JSON.stringify(wrangler))]);
  for (const [path, bytes] of project.assets ?? []) await result.write(`/public${path}`, [bytes]);
  return { files: result, code };
}

describe("readSourceProject", () => {
  test("reads wrangler.jsonc and the files of assets.directory", async () => {
    const project = await readSourceProject(await inMemory(ASSETS));
    expect(project?.config.name).toBe("assets-api");
    expect([...(project?.assets?.keys() ?? [])].sort()).toContain("/index.html");
    expect(project?.assets?.get("/about.html")).toEqual(
      new Uint8Array(readFileSync(join(ASSETS, "public/about.html"))),
    );
  });

  test("assets.directory as Node resolves it: '.', './public/'", async () => {
    const files = new MemFilesApi();
    await files.write("/site/index.html", [enc.encode("<h1>x</h1>")]);
    const config = (directory: string) =>
      enc.encode(JSON.stringify({ name: "x", assets: { directory } }));
    await files.write("/wrangler.json", [config("./site/")]);
    expect([...((await readSourceProject(files))?.assets?.keys() ?? [])]).toEqual(["/index.html"]);
    await files.write("/wrangler.json", [config(".")]);
    expect([...((await readSourceProject(files))?.assets?.keys() ?? [])].sort()).toEqual([
      "/site/index.html",
      "/wrangler.json",
    ]);
  });

  test("undefined for a folder with no wrangler config; an error for one with nothing to run", async () => {
    expect(await readSourceProject(new MemFilesApi())).toBeUndefined();
    const empty = new MemFilesApi();
    await empty.write("/wrangler.json", [enc.encode('{ "name": "x" }')]);
    await expect(readSourceProject(empty)).rejects.toThrow(/neither `main` nor `assets`/);
  });
});

describe("bundleCompiler", () => {
  test("a Durable Object project answers as from its sources", async () => {
    const { files } = await compiled(await inMemory(COUNTER));
    const fromBundle = track(await loadProject(files));
    const counts = [];
    for (const name of ["alpha", "alpha", "beta"])
      counts.push((await (await fromBundle.fetch(req(`/increment?name=${name}`))).json()).n);
    expect(counts).toEqual([1, 2, 1]);
  });

  test("a project with assets answers as from its sources", async () => {
    const { files } = await compiled(await inMemory(ASSETS));
    const fromSource = track(await loadProject(ASSETS));
    const fromBundle = track(await loadProject(files));
    for (const path of ["/", "/about", "/api/x", "/via-binding", "/missing"]) {
      const [a, b] = await Promise.all([fromSource.fetch(req(path)), fromBundle.fetch(req(path))]);
      expect([b.status, await b.text()], path).toEqual([a.status, await a.text()]);
    }
  });

  test("nodejs_compat: node:* come from the runtime, and awaits are lowered", async () => {
    const { files, code } = await compiled(await inMemory(NODE_COMPAT));
    // Nothing of node:* is bundled in: the runtime provides each module.
    expect(code).toContain("__cellsNodeModules");
    expect(code).not.toMatch(/\bawait\b/);
    const project = track(await loadProject(files));
    const res = await project.fetch(req("/"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.crypto.sha256).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(body.buffer.isBuffer).toBe(true);
  });

  test("the from-sources demo's Hono project, its npm packages from the registry", async () => {
    const sources = new MemFilesApi();
    for (const [path, text] of Object.entries(helloHono))
      await sources.write(`/${path}`, [enc.encode(text)]);
    const { files, code } = await compiled(sources);
    expect(code).toContain("hono");
    const project = track(await loadProject(files));
    const hello = async (name: string) =>
      (await project.fetch(req(`/hello/${name}`))).json() as Promise<{ visits: number }>;
    expect((await hello("ada")).visits).toBe(1);
    expect((await hello("ada")).visits).toBe(2);
    expect(await (await project.fetch(req("/"))).text()).toBe("Try /hello/your-name");
  }, 60_000);

  test("nodejs_compat: a node:* module without a polyfill loads, and fails only when used", async () => {
    const files = new MemFilesApi();
    const write = (p: string, t: string) => files.write(p, [enc.encode(t)]);
    await write(
      "/wrangler.json",
      JSON.stringify({ name: "stub", main: "index.js", compatibility_flags: ["nodejs_compat"] }),
    );
    // Two classes named Foo: without keepNames, esbuild renames one of them (Foo2).
    await write("/a.js", "export class Foo {}");
    await write("/b.js", "export class Foo {}");
    await write(
      "/index.js",
      `import { Socket } from "node:net";
import net from "node:net";
import { Foo as A } from "./a.js";
import { Foo as B } from "./b.js";
export default {
  fetch() {
    let error = "";
    try { net.connect(); } catch (e) { error = e.message; }
    let named = "";
    try { new Socket(); } catch (e) { named = e.constructor.name; }
    return Response.json({ names: [A.name, B.name], error, named });
  },
};`,
    );
    const { files: out } = await compiled(files);
    const project = track(await loadProject(out));
    expect(await (await project.fetch(req("/"))).json()).toEqual({
      names: ["Foo", "Foo"],
      error: "node:net.connect is not available in browsers (nodejs_compat)",
      // A named import of a stub is undefined: it fails when used, never when loaded.
      named: "TypeError",
    });
  });
});
