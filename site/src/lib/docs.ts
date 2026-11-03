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
  { file: "packages/cellb/docs/gaps.md", slug: "gaps", label: "Gaps" },
  { file: "packages/cellb/CONTEXT.md", slug: "glossary", label: "Glossary" },
  { file: "packages/cellb/bench/README.md", slug: "benchmarks", label: "Benchmarks" },
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
];

export const repoPages = [...referencePages, ...examplePages];

export const pageHref = (page: RepoPage) => `/docs/${page.slug}`;

const hrefByFile = new Map(repoPages.map((page) => [page.file, pageHref(page)]));

/** The site page of a repository file if the site renders it, else the file on GitHub. */
export const docHref = (file: string) => hrefByFile.get(file) ?? repoFile(file);
