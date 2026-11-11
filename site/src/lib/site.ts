export const REPO = "https://github.com/statewalker/cellb.dev";
/** Links into the repository's default branch. */
export const repoFile = (path: string) => `${REPO}/blob/HEAD/${path}`;
export const CELLD = "https://celld.dev";

/** The examples published as live demos (`.github/workflows/examples-publish.yml`). */
export const LIVE_DEMOS = {
  emdash: {
    href: "https://cellb-emdash.httpeers.net/",
    title: "EmDash, served from a tab",
    body: "EmDash, the Astro CMS, as Astro builds it for Cloudflare, unchanged. Run the setup wizard at /_emdash/admin, sign in with a passkey, and write and publish posts; they stay in this browser.",
    readme: "examples/emdash/README.md",
  },
  astro: {
    href: "https://cellb-astro.httpeers.net/",
    title: "Astro, built in the tab",
    body: "An Astro app's sources built in the tab (esbuild and Astro's compiler as WebAssembly, packages from the npm registry), then run there on CellB: a small app in a few seconds, or EmDash in about 115 s the first time and 65–78 s after (Chrome on a 4-CPU machine).",
    readme: "examples/astro-in-browser/README.md",
  },
} as const;

/** CellB sandbox (apps/sandbox), built into this site (scripts/build-sandbox.mjs). */
export const SANDBOX = {
  href: "/sandbox/app/",
  about: "/sandbox",
  title: "CellB sandbox: an app from your folder",
  body: "Open a folder with a Workers server (wrangler.jsonc, Hono, Durable Objects) and an HTML client in TS or React. The tab compiles both, runs the server on CellB and previews the app, and reruns it when you save. Or try the sample.",
} as const;
