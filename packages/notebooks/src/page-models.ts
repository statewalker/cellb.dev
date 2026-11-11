/**
 * Notebooks → the data an Astro theme renders: one `PageModel` per notebook and one
 * `SiteModel` for navigation. This is the contract between the notebook build and the theme
 * (docs/notebook-runtime/options.md in statewalker-sandbox, Section 3): the theme never parses
 * Markdown or transpiles cells, it lays out prose blocks, cell roots and one module script.
 *
 * A notebook goes through Portable Text first (`portable-text.ts`): Markdown with
 * `@portabletext/markdown`, a Notebook Kit document cell by cell. The document's `cell`s and
 * `expr`s (`${…}` in prose) are numbered and compiled with notebook-build's stages:
 * `resolveNotebook` (`npm:` imports → URLs under the module server's base path) and
 * `transpileNotebook` (cells → `define()` definitions). Prose is rendered from the document, with
 * heading ids and an outline for a table of contents, and the document itself is kept in the
 * model (`content`).
 *
 * What a fence's info string says (` ```js echo `, ` ```js run=false `,
 * ` ```sql database=warehouse output=rows `) reaches the page: `echo` shows the source next to the
 * output, `run=false` shows the source and does not run it, `database`/`output` go to the SQL cell.
 */
import { toNotebook } from "@observablehq/notebook-kit";
import {
  type CellDefinition,
  type DomEnv,
  type ModuleResolver,
  parseNotebookHtml,
  resolveNotebook,
  toModuleRef,
  transpileNotebook,
} from "@statewalker/notebook-build";
import type { FilesApi } from "@statewalker/webrun-files";
import {
  CODE_MODES,
  markdownToDocument,
  type NotebookDocument,
  notebookToDocument,
  numberCells,
  type OutlineEntry,
  type PtBlock,
  type PtCell,
  proseToHtml,
} from "./portable-text.js";

export type { OutlineEntry } from "./portable-text.js";

export type PageBlock =
  | { kind: "prose"; html: string }
  | {
      kind: "cell";
      id: number;
      error?: string;
      /** The cell's source, when the page shows it: `echo`, or `run=false` (shown, not run). */
      source?: string;
      mode?: string;
      run?: boolean;
    };

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
  /** The notebook as Portable Text, cells and expressions numbered (`portable-text.ts`). */
  content: PtBlock[];
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

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A cell that does not run in a page (`html`, `tex`, `dot`, `python`, …; see notebook-build's
 * `CODE_MODES`) stays inert as notebook-build leaves it: `html` as its markup, the others as code.
 */
function inertCellHtml(cell: PtCell): string {
  if (cell.mode === "html") return cell.source;
  return `<pre><code class="language-${escapeHtml(cell.mode)}">${escapeHtml(cell.source)}</code></pre>`;
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

/** A notebook's document: Markdown directly, a Notebook Kit document through notebook-build's parser. */
function documentOf(file: string, text: string, dom: DomEnv): NotebookDocument {
  return file.endsWith(".md")
    ? markdownToDocument(text)
    : notebookToDocument(parseNotebookHtml(text, dom));
}

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
      const doc = documentOf(file, await readText(opts.notebooks, file), opts.dom);
      const { content, cells: specs } = numberCells(doc);
      // `run=false`: shown, not run, so not compiled either.
      const notRun = new Set(
        content
          .filter((b): b is PtCell => b._type === "cell" && (b as PtCell).attrs.run === false)
          .map((c) => c.id as number),
      );
      const nb = toNotebook({
        cells: specs.filter((c) => !notRun.has(c.id)) as never,
        ...(doc.title ? { title: doc.title } : {}),
      });
      const pins = await resolveNotebook(nb, { moduleServer: opts.moduleServer }, file);
      for (const [k, v] of pins) allPins[k] = v;
      const compiled = new Map(transpileNotebook(nb, pins).map((c) => [c.id, c]));
      for (const cell of compiled.values()) for (const name of cell.inputs) allInputs.add(name);

      const outline: OutlineEntry[] = [];
      const used = new Set<string>();
      const blocks: PageBlock[] = [];
      const defines: string[] = [];
      let prose: PtBlock[] = [];
      const flushProse = () => {
        if (prose.length) blocks.push({ kind: "prose", html: proseToHtml(prose, outline, used) });
        prose = [];
      };
      for (const block of content) {
        if (block._type !== "cell") {
          prose.push(block);
          continue;
        }
        const cell = block as PtCell;
        if (!CODE_MODES.has(cell.mode)) {
          flushProse();
          blocks.push({ kind: "prose", html: inertCellHtml(cell) });
          continue;
        }
        flushProse();
        const id = cell.id as number;
        const shown = cell.attrs.echo === true || notRun.has(id);
        const view = shown ? { source: cell.source, mode: cell.mode } : {};
        if (notRun.has(id)) {
          blocks.push({ kind: "cell", id, ...view, run: false });
          continue;
        }
        const def = compiled.get(id);
        if (def?.error) blocks.push({ kind: "cell", id, error: def.error, ...view });
        else {
          blocks.push({ kind: "cell", id, ...view });
          if (def) defines.push(defineCall(def));
        }
      }
      flushProse();
      // The expressions' cells: each displays into its `<span id="cell-<id>">` in the prose.
      for (const spec of specs) {
        const def = compiled.get(spec.id);
        if (def && !content.some((b) => b._type === "cell" && (b as PtCell).id === spec.id))
          if (!def.error) defines.push(defineCall(def));
      }
      // A literal `</script` would end the inline script early; `<\/script` is the same string.
      const script = [`import {define} from "${runtimeUrl}";`, ...defines]
        .join("\n")
        .replace(/<\/script/gi, "<\\/script");
      pages.push({
        id,
        path: pagePath(base, id),
        title: doc.title || id,
        outline,
        blocks,
        script,
        stylesUrl,
        content,
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
