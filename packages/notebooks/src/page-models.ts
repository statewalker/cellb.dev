/**
 * Notebooks → the data an Astro theme renders: one `PageModel` per notebook and one
 * `SiteModel` for navigation. This is the contract between the notebook build and the theme
 * (docs/notebook-runtime/options.md in statewalker-sandbox, Section 3): the theme never parses
 * Markdown or transpiles cells, it lays out prose blocks, cell roots and one module script.
 *
 * The stages are `@statewalker/notebook-build`'s: `parseMarkdown` or `parseNotebookHtml`
 * (Markdown or a Notebook Kit document → notebook-kit `Notebook`), `resolveNotebook` (`npm:` imports → URLs under the module server's base path) and
 * `transpileNotebook` (cells → `define()` definitions). Prose is rendered here with markdown-it,
 * headings get ids, and the outline is collected for a table of contents.
 */
import {
  type CellDefinition,
  type DomEnv,
  type ModuleResolver,
  parseMarkdown,
  parseNotebookHtml,
  resolveNotebook,
  toModuleRef,
  transpileNotebook,
} from "@statewalker/notebook-build";
import type { FilesApi } from "@statewalker/webrun-files";
import MarkdownIt from "markdown-it";

export interface OutlineEntry {
  depth: number;
  text: string;
  slug: string;
}

export type PageBlock =
  | { kind: "prose"; html: string }
  | { kind: "cell"; id: number; error?: string };

export interface PageModel {
  /** The collection entry's id: the notebook's path without its extension (`index`, `guide/plots`). */
  id: string;
  /** The page's URL path under the site's base (`<base>/`, `<base>/guide/plots`). */
  path: string;
  title: string;
  outline: OutlineEntry[];
  blocks: PageBlock[];
  /** The page's module script: imports notebook-kit's runtime and defines every code cell. */
  script: string;
  /** notebook-kit's stylesheet (inspector, cell output). */
  stylesUrl: string;
}

export interface SiteModel {
  title: string;
  /** The home page's path (`<base>/`). */
  home: string;
  pages: { id: string; path: string; title: string }[];
}

export interface PageModels {
  site: SiteModel;
  pages: PageModel[];
  /** Every module the pages import, `npm:` specifier → URL (the runtime included): an export's closure. */
  pins: Record<string, string>;
  /** Every free variable of every cell: which built-ins (`Inputs`, `Plot`, `d3`…) the site uses. */
  inputs: string[];
}

const RUNTIME_SPECIFIER = "npm:@observablehq/notebook-kit/runtime";
/** The modes whose cells run in the page; the same set as notebook-build's `CODE_MODES`. */
const CODE_MODES = new Set(["js", "ts", "ojs", "sql"]);

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");

/** Renders a prose cell; its headings get ids and go into `outline`. */
function renderProse(
  md: InstanceType<typeof MarkdownIt>,
  source: string,
  outline: OutlineEntry[],
  used: Set<string>,
) {
  const tokens = md.parse(source, {});
  for (const [i, t] of tokens.entries()) {
    if (t.type !== "heading_open") continue;
    const text = tokens[i + 1]?.content ?? "";
    let slug = slugify(text) || "section";
    for (let n = 2; used.has(slug); n++) slug = `${slugify(text)}-${n}`;
    used.add(slug);
    t.attrSet("id", slug);
    outline.push({ depth: Number(t.tag.slice(1)), text, slug });
  }
  return md.renderer.render(tokens, md.options, {});
}

/**
 * One `define()` call, as notebook-build's `renderPage` writes it (`renderDefineCall` in
 * render.ts, not exported): `state` is notebook-kit's `DefineState`, and `output` (the singular
 * name of a `sql` cell's variable) is emitted only when there is one.
 */
function defineCall(cell: CellDefinition): string {
  const state = `{root: document.getElementById("cell-${cell.id}"), variables: [], expanded: []}`;
  const output = cell.output === undefined ? "" : `"output":${JSON.stringify(cell.output)},`;
  return (
    `define(${state}, {"id":${cell.id},"body":${cell.body},` +
    `"inputs":${JSON.stringify(cell.inputs)},"outputs":${JSON.stringify(cell.outputs)},` +
    `${output}"autodisplay":${JSON.stringify(cell.autodisplay)}});`
  );
}

async function* walk(files: FilesApi, dir: string): AsyncGenerator<string> {
  for await (const e of files.list(dir)) {
    if (e.kind === "directory") yield* walk(files, e.path);
    else yield e.path;
  }
}

async function readText(files: FilesApi, path: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of files.read(path)) chunks.push(c);
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(bytes);
}

/** The page path of a notebook id under `base`: `index` is the base itself. */
const pagePath = (base: string, id: string) =>
  id === "index" ? `${base}/` : `${base}/${id.replace(/\/index$/, "")}`;

/**
 * The models of every notebook (`.md`, or Notebook Kit `.html`) in `notebooks`. `base` prefixes
 * page paths (`/nb/<site>/t`); `dom` is what `parseNotebookHtml` needs (linkedom in an isolate).
 * A notebook that fails to resolve or parse is reported in `failures` and left out.
 */
export async function buildPageModels(opts: {
  notebooks: FilesApi;
  moduleServer: ModuleResolver;
  dom: DomEnv;
  siteTitle: string;
  base?: string;
}): Promise<PageModels & { failures: { notebook: string; error: string }[] }> {
  const allPins: Record<string, string> = {};
  const allInputs = new Set<string>();
  const base = (opts.base ?? "").replace(/\/$/, "");
  const md = new MarkdownIt({ html: true });
  const runtimeUrl = (await opts.moduleServer.resolve(toModuleRef(RUNTIME_SPECIFIER))).url;
  // The runtime is `<modules>/@observablehq/notebook-kit@<version>/dist/src/runtime/index.js`;
  // the stylesheet sits beside it in the same package.
  const stylesUrl = runtimeUrl.replace(/\/dist\/.*$/, "/dist/src/styles/index.css");
  allPins[RUNTIME_SPECIFIER] = runtimeUrl;

  const paths: string[] = [];
  for await (const p of walk(opts.notebooks, "/")) if (/\.(md|html)$/.test(p)) paths.push(p);
  paths.sort();

  const pages: PageModel[] = [];
  const failures: { notebook: string; error: string }[] = [];
  const seen = new Set<string>();
  for (const file of paths) {
    const id = file.slice(1).replace(/\.(md|html)$/, "");
    if (seen.has(id)) {
      failures.push({ notebook: file, error: `another notebook already publishes "${id}"` });
      continue;
    }
    seen.add(id);
    try {
      const text = await readText(opts.notebooks, file);
      const nb = file.endsWith(".md") ? parseMarkdown(text) : parseNotebookHtml(text, opts.dom);
      const pins = await resolveNotebook(nb, { moduleServer: opts.moduleServer }, file);
      for (const [k, v] of pins) allPins[k] = v;
      const cells = transpileNotebook(nb, pins);
      for (const cell of cells) for (const name of cell.inputs) allInputs.add(name);
      const source = new Map(nb.cells.map((c) => [c.id, c.value]));

      const outline: OutlineEntry[] = [];
      const used = new Set<string>();
      const blocks: PageBlock[] = [];
      const defines: string[] = [];
      for (const cell of cells) {
        if (!CODE_MODES.has(cell.mode)) {
          blocks.push({
            kind: "prose",
            html: renderProse(md, source.get(cell.id) ?? "", outline, used),
          });
        } else if (cell.error) {
          blocks.push({ kind: "cell", id: cell.id, error: cell.error });
        } else {
          blocks.push({ kind: "cell", id: cell.id });
          defines.push(defineCall(cell));
        }
      }
      // A literal `</script` would end the inline script early; `<\/script` is the same string.
      const script = [`import {define} from "${runtimeUrl}";`, ...defines]
        .join("\n")
        .replace(/<\/script/gi, "<\\/script");
      pages.push({
        id,
        path: pagePath(base, id),
        title: nb.title || id,
        outline,
        blocks,
        script,
        stylesUrl,
      });
    } catch (e) {
      failures.push({ notebook: file, error: String((e as Error)?.message ?? e) });
    }
  }
  // Navigation order: the home page first, then by path.
  const order = (p: PageModel) => (p.id === "index" ? "" : p.id);
  pages.sort((a, b) => order(a).localeCompare(order(b)));
  const site: SiteModel = {
    title: opts.siteTitle,
    home: `${base}/`,
    pages: pages.map(({ id, path, title }) => ({ id, path, title })),
  };
  return { site, pages, pins: allPins, inputs: [...allInputs].sort(), failures };
}
