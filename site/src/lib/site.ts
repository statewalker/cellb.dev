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
    body: "An Astro app's sources built in the tab (esbuild and Astro's compiler as WebAssembly, packages from the npm registry), then run there on CellB: a small app in a few seconds, or EmDash in about two minutes the first time.",
    readme: "examples/astro-in-browser/README.md",
  },
} as const;
