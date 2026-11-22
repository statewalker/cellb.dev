// Every example and demo the site shows, in one place: the /examples hub renders all of it, and the
// pages of an area (the home page's real apps, /containers, /sandbox) render their part from here,
// so the hub and the area pages always agree. The 70 conformance scenarios are not here: they come
// from the recorded corpus (lib/examples.ts).
import { builderPages } from "./builders";

/** live: a hosted demo to open in the browser; app: a tested app (a README); area: a worked example of an area. */
export type Kind = "live" | "app" | "area";
export type Area = "core" | "builders" | "containers" | "agents" | "apps";

export interface Entry {
  id: string;
  kind: Kind;
  area: Area;
  /** The group of a live demo on the hub: whole apps, containers, or a Durable Object on this site. */
  group?: "apps" | "containers" | "core";
  title: string;
  /** One or two sentences, for cards. */
  body: string;
  /** A longer text (the home page's real apps). */
  long?: string;
  /** The URL to open (live demos). */
  try?: string;
  /** `try` is another origin. */
  external?: boolean;
  engine?: "Wasmer" | "Lifo";
  /** A page of this site about it. */
  read?: string;
  /** A repository file about it, resolved with docHref (a /docs page, or GitHub). */
  readme?: string;
  /** A repository folder or file with its source, resolved with repoFile. */
  source?: string;
  image?: { src: string; alt: string };
  /** The live demo of an app, or the app of a live demo. */
  related?: string;
}

/** The containers demos' landing page, built into this site (scripts/build-containers-demos.mjs). */
export const CONTAINER_DEMOS_INDEX = "/demos/containers/";
/** The containers demos' README: how they are wired. */
export const CONTAINER_DEMOS_README = "packages/containers/examples/browser-demos/README.md";

const ENTRIES: Entry[] = [
  // Live demos: whole apps in a tab (examples-publish.yml publishes the hosts; one origin each)
  {
    id: "emdash-live",
    kind: "live",
    area: "apps",
    group: "apps",
    title: "EmDash, served from a tab",
    body: "EmDash, the Astro CMS, as Astro builds it for Cloudflare, unchanged. Run the setup wizard at /_emdash/admin, sign in with a passkey, and write and publish posts; they stay in this browser.",
    long: "EmDash, the Astro CMS, runs unchanged from its Cloudflare build: D1, KV sessions, R2 media, a cron trigger, passkeys. A plain file server hands the browser the files and is then stopped. The setup wizard, sign-in, editor and media library all keep working, and the post is still there after the tab is reopened.",
    try: "https://emdash.cellb.dev/",
    external: true,
    readme: "examples/emdash/README.md",
    image: {
      src: "/showcase/emdash-admin-in-tab.png",
      alt: "EmDash's post editor, running in a browser tab on CellB, after publishing a post with a featured image",
    },
    related: "emdash",
  },
  {
    id: "astro-live",
    kind: "live",
    area: "apps",
    group: "apps",
    title: "Astro, built in the tab",
    body: "An Astro app's sources built in the tab (esbuild and Astro's compiler as WebAssembly, packages from the npm registry), then run there on CellB: a small app in a few seconds, or EmDash in about 115 s the first time and 65–78 s after (Chrome on a 4-CPU machine).",
    long: "Astro's compiler and esbuild run as WebAssembly in workers, with packages from the npm registry kept in a package store that is itself a Durable Object. EmDash's 225 routes build in about 65–78 s warm and 115 s cold (4-CPU machine, Chrome for Testing 153) and run on CellB at once, each cell kept in OPFS as LTX files, celld's one-file-per-commit page log.",
    try: "https://astro.cellb.dev/",
    external: true,
    readme: "examples/astro-in-browser/README.md",
    image: {
      src: "/showcase/emdash-built-in-tab.png",
      alt: "The host tab's build log: EmDash's 225 routes built in the browser in about 73 seconds",
    },
    related: "astro-in-browser",
  },
  {
    id: "sandbox",
    kind: "live",
    area: "core",
    group: "apps",
    title: "CellB sandbox: an app from your folder",
    body: "Open a folder with a Workers server (wrangler.jsonc, Hono, Durable Objects) and an HTML client in TS or React. The tab compiles both, runs the server on CellB and previews the app, and reruns it when you save. Or try the sample.",
    try: "/sandbox/app/",
    read: "/sandbox",
    source: "apps/sandbox",
  },
  // Live demos: containers in a tab, one per engine
  {
    id: "containers-python",
    kind: "live",
    area: "containers",
    group: "containers",
    engine: "Wasmer",
    title: "Python in Wasmer containers",
    body: "Run a Python script against files from the page. Each run gets a fresh Python container (WASIX, from the Wasmer registry) in a worker of its own, terminated after the run: it sees only its files at /data, and has no network.",
    try: "/demos/containers/python/",
    read: "/containers",
    readme: CONTAINER_DEMOS_README,
    image: {
      src: "/demos/containers/images/python-1-run.png",
      alt: "The Python demo after a run: the script's output and the file it wrote back to the page",
    },
  },
  {
    id: "containers-notebook",
    kind: "live",
    area: "containers",
    group: "containers",
    engine: "Lifo",
    title: "A notebook in Lifo containers",
    body: "An Observable Framework notebook, edited and previewed in the tab: a build container installs Framework with npm through the page's network (about 30 s), then observable preview runs in a container with no network, with live reload over a WebSocket into it.",
    // an origin of its own: it installs and runs npm packages in the page's realm (Lifo is no
    // sandbox), so it must not share cellb.dev's storage (examples-publish.yml publishes it)
    try: "https://containers.cellb.dev/notebook/",
    external: true,
    read: "/containers",
    readme: CONTAINER_DEMOS_README,
    image: {
      src: "/demos/containers/images/notebook-3-edited.png",
      alt: "The notebook demo after a live edit",
    },
  },
  // Live demo: a Durable Object on this site's home page
  {
    id: "counter",
    kind: "live",
    area: "core",
    group: "core",
    title: "A Durable Object in your tabs",
    body: "The home page's Counter, Workers code as written for Cloudflare, run in this browser: shared by every tab of the site that has the page open, each object in SQLite WASM on OPFS. No server answers its requests.",
    try: "/#demo",
    source: "site/src/demo/counter",
  },
  // Apps tested on CellB (their own end-to-end tests, locally and in CI)
  {
    id: "flue",
    kind: "app",
    area: "agents",
    title: "Flue agent app",
    body: "A full Agents SDK app, built with Flue's own Cloudflare build, in Node and in Chromium; in Node, a second node finishes a conversation whose node stopped mid model call.",
    readme: "examples/flue/README.md",
  },
  {
    id: "agents",
    kind: "app",
    area: "agents",
    title: "pi and opencode",
    body: "Coding agents in Durable Objects, offline against a fake OpenAI-compatible model.",
    readme: "examples/agents/README.md",
  },
  {
    id: "emdash",
    kind: "app",
    area: "apps",
    title: "EmDash (Astro CMS)",
    body: "EmDash's Cloudflare build from static files: the setup wizard, passkeys, the editor and media, checked in Chromium.",
    readme: "examples/emdash/README.md",
    related: "emdash-live",
  },
  {
    id: "astro-in-browser",
    kind: "app",
    area: "apps",
    title: "Astro built in a tab",
    body: "Astro apps, EmDash among them, built from their sources in the browser and run there.",
    readme: "examples/astro-in-browser/README.md",
    related: "astro-live",
  },
  {
    id: "platform-demos",
    kind: "app",
    area: "apps",
    title: "Apps built by the tools",
    body: "Whole apps built with their own toolchains, then bundled or compiled by the platform, and run on Wrangler, celld and CellB.",
    readme: "examples/platform-demos/README.md",
  },
  {
    id: "platform-astro",
    kind: "app",
    area: "apps",
    title: "A small Astro app",
    body: "An Astro app built by the platform's Astro builder and run on CellB.",
    readme: "examples/platform-astro/README.md",
  },
  // Container projects (packages/containers/examples)
  ...(
    [
      ["python", "a stdlib HTTP server per object (Wasmer)"],
      ["php", "PHP's built-in server per object (Wasmer)"],
      ["node", "node:http in wasmer/edgejs (Wasmer, JSPI)"],
      ["pool", "custom code on a pool, against each cell's own files"],
      ["files", "a host FilesApi mounted into a container"],
    ] as const
  ).map(
    ([name, body]): Entry => ({
      id: `container-${name}`,
      kind: "area",
      area: "containers",
      title: name,
      body,
      source: `packages/containers/examples/${name}`,
    }),
  ),
];

// The builders' worked examples: from builderPages, never copied.
const BUILDER_IMAGES: Record<string, string> = {
  "esm-cdn": "/builders/esm-cdn.png",
  "user-code": "/builders/user-code.png",
  astro: "/builders/astro.png",
  notebooks: "/builders/notebooks-plots.png",
};
const BUILDERS: Entry[] = builderPages.map((p) => ({
  id: `builder-${p.slug}`,
  kind: "area",
  area: "builders",
  title: p.label,
  body: p.summary,
  read: p.href,
  image: BUILDER_IMAGES[p.slug]
    ? { src: BUILDER_IMAGES[p.slug], alt: `${p.label}: what its worked example produced` }
    : undefined,
}));

export const entries: readonly Entry[] = [...ENTRIES, ...BUILDERS];

/** An entry by id (throws on an unknown one, so a renamed entry fails the build). */
export function entry(id: string): Entry {
  const e = entries.find((x) => x.id === id);
  if (!e) throw new Error(`showcase: no entry "${id}"`);
  return e;
}

/** The entries of a kind (and area), in catalog order. */
export const byKind = (kind: Kind, area?: Area): Entry[] =>
  entries.filter((e) => e.kind === kind && (!area || e.area === area));

/** The live demos of a group on the hub. */
export const liveGroup = (group: NonNullable<Entry["group"]>): Entry[] =>
  entries.filter((e) => e.kind === "live" && e.group === group);
