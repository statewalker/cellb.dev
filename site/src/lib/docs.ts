import { repoFile } from "./site";

/** A Markdown file of the repository that the site renders at /docs/<slug>. */
export interface RepoPage {
  /** Path from the repository root. */
  file: string;
  slug: string;
  label: string;
}

export const referencePages: RepoPage[] = [
  { file: "packages/cellb/docs/architecture.md", slug: "architecture", label: "Architecture" },
  {
    file: "packages/cellb/docs/ownership-and-durability.md",
    slug: "ownership-and-durability",
    label: "Ownership & durability",
  },
  {
    file: "packages/cellb/docs/browser-host.md",
    slug: "browser-host",
    label: "Running in a browser",
  },
  {
    file: "packages/cellb/docs/browser-capacity.md",
    slug: "browser-capacity",
    label: "Cells per browser",
  },
  {
    file: "packages/cellb/docs/celld-compatibility.md",
    slug: "celld-compatibility",
    label: "celld compatibility",
  },
  { file: "packages/cellb/docs/conformance.md", slug: "conformance", label: "Conformance" },
  { file: "packages/cellb/docs/security.md", slug: "security", label: "Security & isolation" },
  { file: "packages/cellb/docs/gaps.md", slug: "gaps", label: "Gaps" },
  { file: "packages/cellb/CONTEXT.md", slug: "glossary", label: "Glossary" },
  { file: "packages/cellb/bench/README.md", slug: "benchmarks", label: "Benchmarks" },
];

export const servicePages: RepoPage[] = [
  { file: "packages/cellb/docs/services/workers.md", slug: "services/workers", label: "Workers" },
  {
    file: "packages/cellb/docs/services/durable-objects.md",
    slug: "services/durable-objects",
    label: "Durable Objects",
  },
  {
    file: "packages/cellb/docs/services/durable-object-facets.md",
    slug: "services/durable-object-facets",
    label: "Durable Object facets",
  },
  { file: "packages/cellb/docs/services/kv.md", slug: "services/kv", label: "KV" },
  { file: "packages/cellb/docs/services/d1.md", slug: "services/d1", label: "D1" },
  { file: "packages/cellb/docs/services/r2.md", slug: "services/r2", label: "R2" },
  { file: "packages/cellb/docs/services/queues.md", slug: "services/queues", label: "Queues" },
  {
    file: "packages/cellb/docs/services/workflows.md",
    slug: "services/workflows",
    label: "Workflows",
  },
  {
    file: "packages/cellb/docs/services/cron-triggers.md",
    slug: "services/cron-triggers",
    label: "Cron Triggers",
  },
  {
    file: "packages/cellb/docs/services/static-assets.md",
    slug: "services/static-assets",
    label: "Static assets",
  },
  {
    file: "packages/cellb/docs/services/dynamic-workers.md",
    slug: "services/dynamic-workers",
    label: "Dynamic Workers",
  },
  {
    file: "packages/cellb/docs/services/websockets.md",
    slug: "services/websockets",
    label: "WebSockets",
  },
  {
    file: "packages/cellb/docs/services/workers-ai.md",
    slug: "services/workers-ai",
    label: "Workers AI",
  },
];

/** The tools built on cellb (packages/platform and its packages): /docs/tools has the overview. */
export const toolPages: RepoPage[] = [
  { file: "packages/platform/README.md", slug: "tools/platform", label: "The platform" },
  { file: "packages/esm-cdn/README.md", slug: "tools/esm-cdn", label: "ESM CDN & user code" },
  { file: "packages/bundler/README.md", slug: "tools/bundler", label: "Bundler" },
  { file: "packages/astro-builder/README.md", slug: "tools/astro-builder", label: "Astro builder" },
  { file: "packages/notebooks/README.md", slug: "tools/notebooks", label: "Notebooks" },
  {
    file: "packages/platform-core/README.md",
    slug: "tools/platform-core",
    label: "Package store & storage",
  },
];

export const examplePages: RepoPage[] = [
  { file: "examples/flue/README.md", slug: "examples/flue", label: "Flue agent app" },
  { file: "examples/agents/README.md", slug: "examples/agents", label: "pi and opencode" },
  { file: "examples/emdash/README.md", slug: "examples/emdash", label: "EmDash (Astro CMS)" },
  {
    file: "examples/astro-in-browser/README.md",
    slug: "examples/astro-in-browser",
    label: "Astro built in a tab",
  },
  {
    file: "examples/platform-demos/README.md",
    slug: "examples/platform-demos",
    label: "Apps built by the tools",
  },
  {
    file: "examples/platform-astro/README.md",
    slug: "examples/platform-astro",
    label: "A small Astro app",
  },
];

export const repoPages = [...referencePages, ...servicePages, ...toolPages, ...examplePages];

export const pageHref = (page: RepoPage) => `/docs/${page.slug}`;

const hrefByFile = new Map(repoPages.map((page) => [page.file, pageHref(page)]));

/** The site page of a repository file if the site renders it, else the file on GitHub. */
export const docHref = (file: string) => hrefByFile.get(file) ?? repoFile(file);
