import { readFileSync } from "node:fs";
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs script without types
import { fetchAstroCompiler } from "../scripts/fetch-astro-compiler.mjs";
import { compileAstro } from "../src/astro-plugin.js";
import { loadAstroCompiler } from "../src/compiler.js";
import { projectRoutes } from "../src/routes.js";

const PAGE = `---
import Counter from "../components/Counter.tsx";
const title: string = "Hi";
---
<h1>{title}</h1>
<Counter client:load start={0} />
<style>h1 { color: red; }</style>
`;

describe("Astro's compiler as WebAssembly", () => {
  it("compiles as the native compiler-rs does, islands resolved to file ids", async () => {
    const wasm = loadAstroCompiler(readFileSync(await fetchAstroCompiler()));
    const native = (await import("@astrojs/compiler-rs")).transform as never;
    const a = compileAstro(wasm, "~/src/pages/index.astro", PAGE);
    const b = compileAstro(native, "~/src/pages/index.astro", PAGE);
    expect(a.code).toBe(b.code);
    expect(a.css).toEqual(b.css);
    expect(a.hydratedComponents?.map((c) => c.resolvedPath)).toEqual([
      "~/src/components/Counter.tsx",
    ]);
    expect(a.code).toContain('"client:component-path": "~/src/components/Counter.tsx"');
  }, 60_000);
});

describe("projectRoutes", () => {
  it("names routes as Astro's router does; a rest route comes after `/`", async () => {
    const files = new MemFilesApi();
    for (const p of [
      "index.astro",
      "posts/[slug].astro",
      "posts/index.astro",
      "api/time.ts",
      "[...rest].astro",
      "_hidden.astro",
    ])
      await writeText(files, `/src/pages/${p}`, "");
    const routes = await projectRoutes(files, "/");
    expect(routes.map((r) => `${r.route} ${r.type}`)).toEqual([
      "/api/time endpoint",
      "/posts/[slug] page",
      "/posts page",
      "/ page",
      "/[...rest] page",
    ]);
  });
});
