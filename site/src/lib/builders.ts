import type { Recorded } from "@/builders/types";

/** The /builders pages: one per kind of builder the platform has, in reading order. */
export interface BuilderPage {
  slug: string;
  href: string;
  label: string;
  /** The Durable Object that does the work. */
  object: string;
  /** What goes in. */
  input: string;
  /** What comes out. */
  output: string;
  summary: string;
  /** The package with its API reference (rendered at /docs/tools/…). */
  readme: string;
}

export const builderPages: BuilderPage[] = [
  {
    slug: "esm-cdn",
    href: "/builders/esm-cdn",
    label: "ESM modules (CDN)",
    object: "ModuleHost, PackageRegistry",
    input: "an npm package name and a version range",
    output: "each module as browser (or Node) ESM, at an immutable pinned URL",
    summary:
      "npm packages as ES modules, from your own origin: import them from a page or a Worker with no install step and no third-party CDN.",
    readme: "packages/esm-cdn/README.md",
  },
  {
    slug: "user-code",
    href: "/builders/user-code",
    label: "User code as ESM",
    object: "Project",
    input: "a project's files: TS, TSX, JSX, CSS, package.json",
    output: "the files of a snapshot as ES modules, compiled one at a time on request",
    summary:
      "A project's own TypeScript and TSX served to the browser as it is written: write files, take a snapshot, open the page.",
    readme: "packages/esm-cdn/README.md",
  },
  {
    slug: "bundler",
    href: "/builders/bundler",
    label: "Bundler for Durable Objects",
    object: "BuildJob",
    input: "a Workers project: wrangler.jsonc, sources, assets",
    output: "a no_bundle project (one worker.js), project.zip and a Worker Loader payload",
    summary:
      "A Workers project with its Durable Objects bundled into one module that Wrangler, celld and CellB run as they get it.",
    readme: "packages/bundler/README.md",
  },
  {
    slug: "astro",
    href: "/builders/astro",
    label: "Astro builder",
    object: "BuildJob (with the Astro builder)",
    input: "an Astro project's sources, without node_modules",
    output: "what Astro's Cloudflare build writes, bundled into one Worker and client assets",
    summary:
      "Astro sites built from their sources without Node or Vite, in a Durable Object or a browser tab, then run on any host.",
    readme: "packages/astro-builder/README.md",
  },
  {
    slug: "notebooks",
    href: "/builders/notebooks",
    label: "Notebooks",
    object: "NotebookSite",
    input: "Markdown notebooks and Observable Notebook Kit documents",
    output: "pages whose cells run in the browser, npm imports served by the site",
    summary:
      "Markdown and Observable notebooks compiled to live pages inside a Durable Object, with their npm imports served next to them.",
    readme: "packages/notebooks/README.md",
  },
];

const recorded = import.meta.glob<Recorded>("../builders/recorded/*.json", {
  eager: true,
  import: "default",
});

/** What `scripts/record-builders.ts` recorded for one kind. */
export function recordedOf(kind: string): Recorded {
  const r = recorded[`../builders/recorded/${kind}.json`];
  if (!r) throw new Error(`no recording for ${kind}: run pnpm record:builders ${kind}`);
  return r;
}

/** The previous and next pages, for the links at the bottom of each page. */
export function neighbours(slug: string) {
  const i = builderPages.findIndex((p) => p.slug === slug);
  return { prev: builderPages[i - 1], next: builderPages[i + 1] };
}

/** Shiki's language for a file name. */
export function langOf(path: string): string {
  const ext = path.split(".").pop() ?? "";
  return (
    {
      ts: "ts",
      tsx: "tsx",
      js: "js",
      mjs: "js",
      html: "html",
      css: "css",
      json: "json",
      jsonc: "jsonc",
      md: "md",
      astro: "astro",
    }[ext] ?? "txt"
  );
}
