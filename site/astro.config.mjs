// @ts-check

import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { rehypeRepoLinks } from "./src/lib/rehype-repo-links.ts";

export default defineConfig({
  site: "https://cellb.dev",
  vite: { plugins: [tailwindcss()] },
  markdown: {
    // The theme CodeBlock uses, so code reads the same in Markdown pages and hand-written ones.
    shikiConfig: { theme: "github-dark-default" },
    rehypePlugins: [[rehypeRepoLinks, { root: fileURLToPath(new URL("..", import.meta.url)) }]],
  },
});
