// After `astro build`: CellB sandbox (apps/sandbox), built for the path cellb.dev serves it under,
// and copied into the site's dist/ there. The page about it is src/pages/sandbox.astro (/sandbox/).
//
//   apps/sandbox/dist  →  dist/sandbox/app/    (SANDBOX_BASE=/sandbox/app/)
//
// The sandbox's ServiceWorker (dist/sandbox/app/sw-worker.js) then has scope /sandbox/app/: it
// never controls the site's other pages, and the homepage demo's worker (scope "/") does not
// control the sandbox.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";

export const SANDBOX_BASE = "/sandbox/app/";
const app = new URL("../../apps/sandbox/", import.meta.url).pathname;
const target = new URL(`../dist${SANDBOX_BASE}`, import.meta.url).pathname;

execFileSync("pnpm", ["--filter", "@statewalker/cellb-sandbox", "build"], {
  stdio: "inherit",
  env: { ...process.env, SANDBOX_BASE },
});
if (!existsSync(`${app}dist/index.html`))
  throw new Error("apps/sandbox/dist/index.html is missing");
rmSync(target, { recursive: true, force: true });
cpSync(`${app}dist`, target, { recursive: true });
console.log(`sandbox: apps/sandbox/dist copied to dist${SANDBOX_BASE}`);
