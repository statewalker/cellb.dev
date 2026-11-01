import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transform } from "@astrojs/compiler-rs";
import { loadNodeProject, nodeSqliteOpener } from "@statewalker/cellb/node";
import { npmPackages } from "@statewalker/webrun-bundler";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import * as esbuild from "esbuild-wasm";
import { expect, it } from "vitest";
import { type AstroTransform, buildAstroApp } from "../src/index.ts";

// A project as a notebook site would hand it to the builder: a layout, a component with a
// scoped style, a page per entry of a LIVE collection (content as data, read at request time),
// an inline module script that must reach the page verbatim, and an endpoint.
const PROJECT: Record<string, string> = {
  "/site/package.json": JSON.stringify({ type: "module", dependencies: { astro: "7.4.4" } }),
  "/site/src/live.config.ts": `
import { defineLiveCollection } from "astro:content";
const pages = {
  intro: { title: "Intro", body: "First page" },
  plots: { title: "Plots", body: "Second page" },
};
export const collections = {
  pages: defineLiveCollection({
    loader: {
      name: "test-pages",
      loadCollection: async () => ({
        entries: Object.entries(pages).map(([id, data]) => ({ id, data })),
      }),
      loadEntry: async ({ filter }) => {
        const data = pages[filter.id];
        return data ? { id: filter.id, data } : undefined;
      },
    },
  }),
};`,
  "/site/src/layouts/Base.astro": `---
const { title } = Astro.props;
---
<html><head><title>{title}</title></head><body><slot /></body></html>`,
  "/site/src/components/Box.astro": `<div class="box"><slot /></div>
<style>.box { border: 1px solid rebeccapurple; }</style>`,
  "/site/src/pages/index.astro": `---
import { getLiveCollection } from "astro:content";
import Base from "../layouts/Base.astro";
const { entries } = await getLiveCollection("pages");
---
<Base title="Index"><ul>{entries.map((e) => <li><a href={"/p/" + e.id}>{e.data.title}</a></li>)}</ul></Base>`,
  "/site/src/pages/p/[id].astro": `---
import { getLiveEntry } from "astro:content";
import Base from "../../layouts/Base.astro";
import Box from "../../components/Box.astro";
const { entry } = await getLiveEntry("pages", Astro.params.id);
if (!entry) return new Response("not found", { status: 404 });
---
<Base title={entry.data.title}>
  <Box><p>{entry.data.body}</p></Box>
  <div id="cell-1"></div>
  <script type="module" is:inline>define({ id: 1, body: () => 1 + 1 });</script>
</Base>`,
  "/site/src/pages/api/hello.ts": `export const GET = ({ url }) => Response.json({ hello: url.pathname });`,
};

it("builds an Astro project from a FilesApi and its Worker serves it on cellb", async () => {
  const files = new MemFilesApi({ initialFiles: PROJECT });
  const built = await buildAstroApp({
    esbuild,
    transform: transform as unknown as AstroTransform,
    files,
    root: "/site",
    packages: npmPackages(),
  });
  expect(built.routes.map((r) => r.route).sort()).toEqual(["/", "/api/hello", "/p/[id]"]);
  expect(built.inputs.some((id) => id.includes("src/pages/p/[id].astro"))).toBe(true);

  const dir = mkdtempSync(join(tmpdir(), "astro-builder-"));
  writeFileSync(join(dir, "worker.js"), built.code);
  writeFileSync(
    join(dir, "wrangler.json"),
    JSON.stringify({
      name: "site",
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

    const index = await get("/");
    expect(index.status).toBe(200);
    const indexHtml = await index.text();
    expect(indexHtml).toContain('<a href="/p/intro">Intro</a>');
    expect(indexHtml).toContain('<a href="/p/plots">Plots</a>');

    const page = await get("/p/plots");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<title>Plots</title>");
    expect(html).toContain("Second page");
    expect(html).toMatch(/\.box\[data-astro-cid-\w+\]\s*\{\s*border: 1px solid #639/); // scoped, inlined
    // An inline module script reaches the page unchanged: where a notebook's define() calls go.
    expect(html).toContain('<script type="module">define({ id: 1, body: () => 1 + 1 });</script>');

    expect((await get("/p/nope")).status).toBe(404);
    expect(await (await get("/api/hello")).json()).toEqual({ hello: "/api/hello" });
  } finally {
    await runtime.close();
  }
});
