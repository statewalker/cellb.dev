// After `astro build`: the containers demos (packages/containers/examples/browser-demos), built for
// the path cellb.dev serves them under, and copied into the site's dist/ there. The page about them
// is src/pages/containers.astro (/containers/).
//
//   packages/containers/examples/browser-demos/dist  →  dist/demos/containers/
//     index.html    the two demos
//     python/       Python in Wasmer containers
//
// Only the Wasmer demo is served from cellb.dev: its page runs this repository's code, and the
// guest's Python runs in Wasmer's sandbox. The notebook (Lifo) installs and runs npm packages in
// the page's realm, so it has an origin of its own, NOTEBOOK_ORIGIN, published by
// .github/workflows/examples-publish.yml; the landing page links it there.
//
// The demos' ServiceWorker (dist/demos/containers/sw-worker.js) has scope /demos/containers/: it
// gives those pages cross-origin isolation (the static host sends no COOP/COEP headers); it never
// controls the site's other pages.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";

export const DEMOS_BASE = "/demos/containers/";
export const NOTEBOOK_ORIGIN = "https://cellb-containers.httpeers.net";
const pkg = new URL("../../packages/containers/", import.meta.url).pathname;
const out = `${pkg}examples/browser-demos/dist`;
const target = new URL(`../dist${DEMOS_BASE}`, import.meta.url).pathname;

execFileSync(
  "pnpm",
  [
    "exec",
    "vite",
    "build",
    "--config",
    "examples/browser-demos/vite.config.ts",
    "--logLevel",
    "warn",
  ],
  {
    cwd: pkg,
    stdio: "inherit",
    env: {
      ...process.env,
      DEMOS_BASE,
      DEMOS_PAGES: "python",
      DEMOS_NOTEBOOK_HREF: `${NOTEBOOK_ORIGIN}/notebook/`,
    },
  },
);
for (const page of ["index.html", "python/index.html", "sw-worker.js"])
  if (!existsSync(`${out}/${page}`)) throw new Error(`browser-demos: ${page} is missing`);
rmSync(target, { recursive: true, force: true });
cpSync(out, target, { recursive: true });
// the screenshots the /containers page shows
cpSync(`${pkg}docs/images`, `${target}images`, { recursive: true });
console.log(`containers demos: examples/browser-demos/dist copied to dist${DEMOS_BASE}`);
