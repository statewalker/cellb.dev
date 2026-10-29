import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transform } from "@astrojs/compiler-rs";
import { loadNodeProject, nodeSqliteOpener } from "@statewalker/cellb/node";
import { npmPackages } from "@statewalker/webrun-bundler";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import * as esbuild from "esbuild-wasm";
import { expect, it } from "vitest";
import { buildAstroApp } from "../src/builder/build.ts";
import { appFiles } from "./load-app.ts";

// The same build the browser runs (esbuild-wasm, packages from the npm registry, sources in a
// FilesApi), with the native build of Astro's compiler; its Worker then runs on cellb in Node.
it("builds the Astro app from its sources and serves it on cellb", async () => {
  const files = await appFiles();
  const built = await buildAstroApp({
    esbuild,
    transform: transform as never,
    files,
    root: "/app",
    packages: npmPackages(),
    log: (m) => console.log(m),
  });
  console.log(
    `built in ${built.ms} ms: ${(built.code.length / 1e6).toFixed(2)} MB, ${built.inputs.length} inputs`,
  );
  const dir = mkdtempSync(join(tmpdir(), "astro-in-browser-"));
  writeFileSync(join(dir, "worker.js"), built.code);
  writeFileSync(
    join(dir, "wrangler.json"),
    JSON.stringify({
      name: "app",
      main: "worker.js",
      compatibility_date: "2026-02-24",
      compatibility_flags: ["nodejs_compat"],
    }),
  );
  const { runtime, unsupported } = await loadNodeProject(dir, {
    openSql: nodeSqliteOpener(),
    files: new MemFilesApi(),
  });
  try {
    expect(unsupported).toEqual([]);
    const get = (p: string) => runtime.fetch(new Request(`http://localhost${p}`));
    const home = await get("/");
    const html = await home.text();
    console.log(home.status, html.slice(0, 600));
    expect(home.status).toBe(200);
    expect(home.headers.get("x-built-in")).toBe("browser");
    expect(html).toContain("An Astro site built in this browser");
    expect(html).toContain("Cells in the browser");
    expect(html).toContain("linear-gradient"); // the Card's scoped style, inlined
    const post = await get("/posts/hello");
    expect(await post.text()).toContain("No Node.js was involved");
    const api = await (await get("/api/time")).json();
    expect(api.path).toBe("/api/time");
    expect((await get("/posts/nope")).status).toBe(302);
  } finally {
    await runtime.close();
  }
});
