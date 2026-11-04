// @ts-check

import { fileURLToPath } from "node:url";
import { unified } from "@astrojs/markdown-remark";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { rehypeRepoLinks } from "./src/lib/rehype-repo-links.ts";

export default defineConfig({
  site: "https://cellb.dev",
  vite: {
    plugins: [tailwindcss()],
    // The homepage demo's worker runs cellb: SQLite WASM finds its .wasm next to its own module,
    // so it is not pre-bundled, and the worker is an ES module (it starts nested workers).
    optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
    worker: { format: "es" },
    resolve: {
      alias: {
        "lightningcss-wasm": fileURLToPath(
          new URL("./src/demo/no-lightningcss.ts", import.meta.url),
        ),
      },
    },
  },
  markdown: {
    // The theme CodeBlock uses, so code reads the same in Markdown pages and hand-written ones.
    shikiConfig: { theme: "github-dark-default" },
    // The unified processor, not Astro's default, because the repository's Markdown needs its
    // relative links rewritten for the site (rehypeRepoLinks).
    processor: unified({
      rehypePlugins: [[rehypeRepoLinks, { root: fileURLToPath(new URL("..", import.meta.url)) }]],
    }),
  },
});
