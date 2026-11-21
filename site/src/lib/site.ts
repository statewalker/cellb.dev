export const REPO = "https://github.com/statewalker/cellb.dev";
/** Links into the repository's default branch. */
export const repoFile = (path: string) => `${REPO}/blob/HEAD/${path}`;
export const CELLD = "https://celld.dev";

/** The examples published as live demos (`.github/workflows/examples-publish.yml`). */
export const LIVE_DEMOS = {
  emdash: {
    href: "https://emdash.cellb.dev/",
    title: "EmDash, served from a tab",
    body: "EmDash, the Astro CMS, as Astro builds it for Cloudflare, unchanged. Run the setup wizard at /_emdash/admin, sign in with a passkey, and write and publish posts; they stay in this browser.",
    readme: "examples/emdash/README.md",
  },
  astro: {
    href: "https://astro.cellb.dev/",
    title: "Astro, built in the tab",
    body: "An Astro app's sources built in the tab (esbuild and Astro's compiler as WebAssembly, packages from the npm registry), then run there on CellB: a small app in a few seconds, or EmDash in about 115 s the first time and 65–78 s after (Chrome on a 4-CPU machine).",
    readme: "examples/astro-in-browser/README.md",
  },
} as const;

/**
 * The containers demos (packages/containers/examples/browser-demos), one per engine: the Wasmer
 * one built into this site at /demos/containers/ (scripts/build-containers-demos.mjs), the Lifo
 * one on an origin of its own.
 */
export const CONTAINER_DEMOS = {
  index: "/demos/containers/",
  about: "/containers",
  readme: "packages/containers/examples/browser-demos/README.md",
  python: {
    href: "/demos/containers/python/",
    engine: "Wasmer",
    title: "Python in Wasmer containers",
    body: "Run a Python script against files from the page. Each run gets a fresh Python container (WASIX, from the Wasmer registry) in a worker of its own, terminated after the run: it sees only its files at /data, and has no network.",
  },
  notebook: {
    // an origin of its own: it installs and runs npm packages in the page's realm (Lifo is no
    // sandbox), so it must not share cellb.dev's storage (examples-publish.yml publishes it)
    href: "https://containers.cellb.dev/notebook/",
    engine: "Lifo",
    title: "A notebook in Lifo containers",
    body: "An Observable Framework notebook, edited and previewed in the tab: a build container installs Framework with npm through the page's network (about 30 s), then observable preview runs in a container with no network, with live reload over a WebSocket into it.",
  },
} as const;

/** CellB sandbox (apps/sandbox), built into this site (scripts/build-sandbox.mjs). */
export const SANDBOX = {
  href: "/sandbox/app/",
  about: "/sandbox",
  title: "CellB sandbox: an app from your folder",
  body: "Open a folder with a Workers server (wrangler.jsonc, Hono, Durable Objects) and an HTML client in TS or React. The tab compiles both, runs the server on CellB and previews the app, and reruns it when you save. Or try the sample.",
} as const;
