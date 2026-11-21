// After `astro build`: the containers demos (packages/containers/examples/browser-demos), built for
// the path cellb.dev serves them under, and copied into the site's dist/ there. The page about them
// is src/pages/containers.astro (/containers/).
//
//   packages/containers/examples/browser-demos/dist  →  dist/demos/containers/
//     index.html    the two demos
//     python/       Python in Wasmer containers
//     notebook/     an Observable Framework notebook in Lifo containers
//
// Their ServiceWorker (dist/demos/containers/sw-worker.js) has scope /demos/containers/: it gives
// those pages cross-origin isolation (the static host sends no COOP/COEP headers) and routes the
// notebook's preview to its page; it never controls the site's other pages.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";

export const DEMOS_BASE = "/demos/containers/";
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
  { cwd: pkg, stdio: "inherit", env: { ...process.env, DEMOS_BASE } },
);
for (const page of ["index.html", "python/index.html", "notebook/index.html", "sw-worker.js"])
  if (!existsSync(`${out}/${page}`)) throw new Error(`browser-demos: ${page} is missing`);
rmSync(target, { recursive: true, force: true });
cpSync(out, target, { recursive: true });
console.log(`containers demos: examples/browser-demos/dist copied to dist${DEMOS_BASE}`);
