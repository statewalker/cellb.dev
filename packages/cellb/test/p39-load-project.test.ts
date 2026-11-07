// loadProject (Node) and `cellb build` (#67): one loader for a source folder, a built folder and
// a FilesApi, and a build whose folder loads the same way.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { buildProject, loadProject } from "@statewalker/cellb/node";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterEach, describe, expect, test } from "vitest";

const PKG = resolve(import.meta.dirname, "..");
const COUNTER = join(PKG, "conformance/celld-examples/counter");
const ASSETS = join(PKG, "conformance/projects/assets-api");
const NODE_COMPAT = join(PKG, "conformance/projects/node-compat");

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const req = (path: string) => new Request(`http://localhost${path}`);
const opened: { close(): Promise<void> }[] = [];
const track = <T extends { close(): Promise<void> }>(p: T) => {
  opened.push(p);
  return p;
};
afterEach(async () => {
  for (const p of opened.splice(0)) await p.close();
});

async function counterRun(project: Awaited<ReturnType<typeof loadProject>>) {
  const a1 = await (await project.fetch(req("/increment?name=alpha"))).json();
  const a2 = await (await project.fetch(req("/increment?name=alpha"))).json();
  const b1 = await (await project.fetch(req("/increment?name=beta"))).json();
  return [a1.n, a2.n, b1.n];
}

describe("loadProject on Node", () => {
  test("a source folder: main bundled with esbuild", async () => {
    const project = track(await loadProject(COUNTER));
    expect(project.config.name).toBe("counter");
    expect(project.unsupported).toEqual([]);
    expect(await counterRun(project)).toEqual([1, 2, 1]);
  });

  test("data: cells kept in a directory outlive the project", async () => {
    const data = tmp("cellb-data-");
    const first = await loadProject(COUNTER, { data });
    expect(await counterRun(first)).toEqual([1, 2, 1]);
    await first.close();
    expect(readdirSync(data).some((f) => f.endsWith(".sqlite"))).toBe(true);
    expect(existsSync(join(data, "files"))).toBe(true);
    const second = track(await loadProject(COUNTER, { data }));
    expect(await counterRun(second)).toEqual([3, 4, 2]);
  });

  test("a FilesApi holding a source folder", async () => {
    const files = new MemFilesApi();
    for (const name of readdirSync(COUNTER))
      await files.write(`/${name}`, [new Uint8Array(readFileSync(join(COUNTER, name)))]);
    const project = track(await loadProject(files));
    expect(await counterRun(project)).toEqual([1, 2, 1]);
  });
});

describe("buildProject / cellb build", () => {
  test("writes wrangler.json, worker.js, assets/ and cellb.json", async () => {
    const out = tmp("cellb-build-");
    const manifest = await buildProject(ASSETS, out);
    expect(manifest.format).toBe("cellb-build/1");
    expect(manifest.main).toBe("worker.js");
    expect(manifest.assets).toContain("/index.html");
    const config = JSON.parse(readFileSync(join(out, "wrangler.json"), "utf8"));
    expect(config.main).toBe("worker.js");
    expect(config.assets.directory).toBe("assets");
    expect(config.assets.binding).toBe("ASSETS");
    expect(readFileSync(join(out, "assets/index.html"))).toEqual(
      readFileSync(join(ASSETS, "public/index.html")),
    );
    // every asset in the manifest, and only those
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) =>
        statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)],
      );
    expect(
      walk(join(out, "assets"))
        .map((f) => `/${relative(join(out, "assets"), f)}`)
        .sort(),
    ).toEqual(manifest.assets);
  });

  test("a built folder loads on Node as its source does", async () => {
    const out = tmp("cellb-build-");
    await buildProject(ASSETS, out);
    const fromSource = track(await loadProject(ASSETS));
    const fromBuild = track(await loadProject(out));
    for (const path of ["/", "/about", "/api/x", "/via-binding", "/missing"]) {
      const [a, b] = await Promise.all([fromSource.fetch(req(path)), fromBuild.fetch(req(path))]);
      expect([b.status, await b.text()], path).toEqual([a.status, await a.text()]);
    }
  });

  test("a built folder with Durable Objects, from a FilesApi", async () => {
    const out = tmp("cellb-build-");
    await buildProject(COUNTER, out);
    const files = new MemFilesApi();
    for (const name of readdirSync(out))
      await files.write(`/${name}`, [new Uint8Array(readFileSync(join(out, name)))]);
    const project = track(await loadProject(files));
    expect(await counterRun(project)).toEqual([1, 2, 1]);
  });

  test("nodejs_compat: the build bundles browser polyfills, and still runs", async () => {
    const out = tmp("cellb-build-");
    await buildProject(NODE_COMPAT, out);
    const project = track(await loadProject(out));
    const res = await project.fetch(req("/"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.crypto.sha256).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(body.buffer.isBuffer).toBe(true);
  });

  test("the cellb command", () => {
    const out = tmp("cellb-cli-");
    const stdout = execFileSync(
      process.execPath,
      [join(PKG, "bin/cellb.mjs"), "build", COUNTER, "--out", out],
      { encoding: "utf8" },
    );
    expect(stdout).toContain("cellb build:");
    expect(JSON.parse(readFileSync(join(out, "cellb.json"), "utf8"))).toEqual({
      format: "cellb-build/1",
      main: "worker.js",
      assets: [],
    });
    expect(() =>
      execFileSync(process.execPath, [join(PKG, "bin/cellb.mjs"), "deploy"], { stdio: "pipe" }),
    ).toThrow();
  });
});
