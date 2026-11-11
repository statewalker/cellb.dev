/**
 * Notebooks as Portable Text: the document form of a notebook, from which the page models are
 * derived (docs/notebook-runtime/options.md in statewalker-sandbox, Section 2: Portable Text as the
 * document IR, notebook-kit's `Notebook` derived from it as the executable IR).
 *
 * The schema is Portable Text's own (as `@portabletext/markdown` writes it: `block`s with styles,
 * marks and lists; `code` objects for fences that do not run) plus two types:
 *
 * - `cell`, a block object: a code cell. `mode` (`js`, `ts`, `ojs`, `sql`, and the modes
 *   notebook-kit has that do not run in a page: `html`, `tex`, `dot`, …), `source`, and `attrs`
 *   from the fence's info string (` ```js echo `, ` ```sql database=warehouse output=rows `);
 *   `id` once numbered.
 * - `expr`, an inline object: a `${…}` in prose, `source` its expression; `id` once numbered. It
 *   runs as a cell of its own and displays in place.
 *
 * Keys are deterministic (`b<n>`, `b<n>s<m>`): the same notebook gives the same document, so the
 * page models' hash changes only when the notebook does.
 */
import type { Notebook } from "@observablehq/notebook-kit";
import { markdownToPortableText } from "@portabletext/markdown";
import { toHTML } from "@portabletext/to-html";

export interface CellAttrs {
  echo?: boolean;
  run?: boolean;
  database?: string;
  output?: string;
  [name: string]: string | boolean | undefined;
}

export interface PtSpan {
  _type: "span";
  _key: string;
  text: string;
  marks?: string[];
}
export interface PtExpr {
  _type: "expr";
  _key: string;
  source: string;
  id?: number;
}
export interface PtTextBlock {
  _type: "block";
  _key: string;
  style?: string;
  listItem?: string;
  level?: number;
  markDefs?: { _key: string; _type: string; [k: string]: unknown }[];
  children: (PtSpan | PtExpr)[];
}
export interface PtCell {
  _type: "cell";
  _key: string;
  mode: string;
  source: string;
  attrs: CellAttrs;
  id?: number;
}
export interface PtObject {
  _type: string;
  _key: string;
  [k: string]: unknown;
}
export type PtBlock = PtTextBlock | PtCell | PtObject;

export interface NotebookDocument {
  title?: string;
  /** notebook-kit's theme name (front matter `theme:`, or a Notebook Kit document's). */
  theme?: unknown;
  content: PtBlock[];
}

/** Fence languages that are notebook-kit cell modes (notebook-build's `md-parse` table). */
export const FENCE_MODES: Record<string, string> = {
  js: "js",
  javascript: "js",
  ts: "ts",
  typescript: "ts",
  ojs: "ojs",
  sql: "sql",
  html: "html",
  tex: "tex",
  latex: "tex",
  dot: "dot",
  python: "python",
  py: "python",
  r: "r",
};

/** The modes whose cells run in the page; the same set as notebook-build's `CODE_MODES`. */
export const CODE_MODES = new Set(["js", "ts", "ojs", "sql"]);

/** `js echo run=false database=x output="a b"` → `{ lang: "js", attrs }`. */
export function parseInfo(info: string): { lang: string; attrs: CellAttrs } {
  const [lang = "", ...rest] = info.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const attrs: CellAttrs = {};
  for (const part of rest) {
    const at = part.indexOf("=");
    if (at < 0) {
      attrs[part] = true;
      continue;
    }
    const value = part.slice(at + 1).replace(/^(["'])(.*)\1$/, "$2");
    attrs[part.slice(0, at)] = value === "true" ? true : value === "false" ? false : value;
  }
  return { lang: lang.toLowerCase(), attrs };
}

/** Splits `${expr}` out of a span's text into `expr` inline objects (balanced braces). */
function splitExpressions(span: PtSpan): (PtSpan | PtExpr)[] {
  if (span.marks?.includes("code") || !span.text.includes("${")) return [span];
  const out: (PtSpan | PtExpr)[] = [];
  let text = span.text;
  let at = text.indexOf("${");
  while (at >= 0) {
    let depth = 0;
    let end = -1;
    for (let i = at + 2; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        if (depth === 0) {
          end = i;
          break;
        }
        depth--;
      }
    }
    if (end < 0) break;
    if (at > 0) out.push({ ...span, text: text.slice(0, at) });
    out.push({ _type: "expr", _key: "", source: text.slice(at + 2, end).trim() });
    text = text.slice(end + 1);
    at = text.indexOf("${");
  }
  if (text) out.push({ ...span, text });
  return out;
}

/** Deterministic keys: `b<n>` for blocks, `b<n>s<m>` for children, `b<n>m<m>` for mark defs. */
function rekey(content: PtBlock[]): PtBlock[] {
  return content.map((block, n) => {
    const key = `b${n}`;
    if (block._type !== "block") return { ...block, _key: key };
    const b = block as PtTextBlock;
    const defs = new Map<string, string>();
    const markDefs = (b.markDefs ?? []).map((d, m) => {
      defs.set(d._key, `${key}m${m}`);
      return { ...d, _key: `${key}m${m}` };
    });
    return {
      ...b,
      _key: key,
      markDefs,
      children: b.children.map((c, m) =>
        c._type === "span"
          ? { ...c, _key: `${key}s${m}`, marks: (c.marks ?? []).map((x) => defs.get(x) ?? x) }
          : { ...c, _key: `${key}s${m}` },
      ),
    };
  });
}

/** `---\nkey: value\n---` front matter, as notebook-build's `md-parse` reads it. */
function splitFrontMatter(source: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { meta: {}, body: source };
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { meta, body: source.slice(match[0].length) };
}

/** Markdown prose (no front matter) → Portable Text, fences that are cell modes → `cell`s, `${…}` → `expr`s. */
function proseToPt(markdown: string): PtBlock[] {
  const blocks = markdownToPortableText(markdown) as unknown as PtBlock[];
  return blocks.map((block) => {
    if (block._type === "code") {
      const { lang, attrs } = parseInfo(String(block.language ?? ""));
      const mode = FENCE_MODES[lang];
      if (mode) {
        const source = String(block.code ?? "");
        return { _type: "cell", _key: block._key, mode, source, attrs } satisfies PtCell;
      }
      return block;
    }
    if (block._type !== "block") return block;
    const b = block as PtTextBlock;
    return {
      ...b,
      children: b.children.flatMap((c) => (c._type === "span" ? splitExpressions(c) : [c])),
    };
  });
}

/** The first h1's text, as notebook-build takes a Markdown notebook's title. */
function firstHeading(content: PtBlock[]): string | undefined {
  for (const block of content)
    if (block._type === "block" && (block as PtTextBlock).style === "h1")
      return blockText(block as PtTextBlock);
  return undefined;
}

export function blockText(block: PtTextBlock): string {
  return block.children
    .map((c) => (c._type === "span" ? c.text : `\${${(c as PtExpr).source}}`))
    .join("");
}

/** A Markdown notebook as a document. */
export function markdownToDocument(source: string): NotebookDocument {
  const { meta, body } = splitFrontMatter(source);
  const content = rekey(proseToPt(body));
  return {
    content,
    ...((meta.title ?? firstHeading(content))
      ? { title: meta.title ?? firstHeading(content) }
      : {}),
    ...(meta.theme ? { theme: meta.theme } : {}),
  };
}

/** Strips the indentation every non-blank line shares (a `<script type="text/markdown">` is indented). */
function dedent(text: string): string {
  const lines = text.replace(/^\s*\n/, "").split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)?.[0].length ?? 0);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut)).join("\n");
}

/** A notebook-kit `Notebook` (a Notebook Kit `.html` document) as a document: `md` cells as prose. */
export function notebookToDocument(nb: Notebook): NotebookDocument {
  const content: PtBlock[] = [];
  for (const cell of nb.cells) {
    if (cell.mode === "md") content.push(...proseToPt(dedent(cell.value)));
    else
      content.push({
        _type: "cell",
        _key: "",
        mode: cell.mode,
        source: cell.value,
        attrs: {
          ...(cell.output ? { output: cell.output } : {}),
          ...(cell.database ? { database: cell.database } : {}),
        },
      } satisfies PtCell);
  }
  return { content: rekey(content), title: nb.title, ...(nb.theme ? { theme: nb.theme } : {}) };
}

/**
 * Numbers the document's cells and expressions in document order (1, 2, …: notebook-kit treats a
 * cell id that is not a positive integer as absent) and returns the cell specs notebook-kit's
 * transpiler takes: one per `cell`, one `js` cell per `expr`.
 */
export function numberCells(doc: NotebookDocument): {
  content: PtBlock[];
  cells: { id: number; mode: string; value: string; output?: string; database?: string }[];
} {
  let id = 1;
  const cells: { id: number; mode: string; value: string; output?: string; database?: string }[] =
    [];
  const content = doc.content.map((block) => {
    if (block._type === "cell") {
      const c = block as PtCell;
      const numbered = { ...c, id: id++ };
      cells.push({
        id: numbered.id,
        mode: c.mode,
        value: c.source,
        ...(typeof c.attrs.output === "string" ? { output: c.attrs.output } : {}),
        ...(typeof c.attrs.database === "string" ? { database: c.attrs.database } : {}),
      });
      return numbered;
    }
    if (block._type !== "block") return block;
    const b = block as PtTextBlock;
    return {
      ...b,
      children: b.children.map((c) => {
        if (c._type !== "expr") return c;
        const numbered = { ...(c as PtExpr), id: id++ };
        cells.push({ id: numbered.id, mode: "js", value: numbered.source });
        return numbered;
      }),
    };
  });
  return { content, cells };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");

export interface OutlineEntry {
  depth: number;
  text: string;
  slug: string;
}

/**
 * Prose blocks → HTML: headings get ids (collected into `outline`), an `expr` becomes the
 * `<span id="cell-<id>">` its cell displays into, a non-cell `code` block a `<pre><code>`.
 */
export function proseToHtml(blocks: PtBlock[], outline: OutlineEntry[], used: Set<string>): string {
  const heading =
    (tag: string) =>
    ({ value, children }: { value: unknown; children?: string }) => {
      const text = blockText(value as PtTextBlock);
      const base = slugify(text) || "section";
      let slug = base;
      for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
      used.add(slug);
      outline.push({ depth: Number(tag.slice(1)), text, slug });
      return `<${tag} id="${slug}">${children ?? ""}</${tag}>`;
    };
  return toHTML(blocks as never, {
    components: {
      block: {
        h1: heading("h1"),
        h2: heading("h2"),
        h3: heading("h3"),
        h4: heading("h4"),
        h5: heading("h5"),
        h6: heading("h6"),
      },
      types: {
        expr: ({ value }: { value: PtExpr }) => `<span id="cell-${value.id}" class="expr"></span>`,
        code: ({ value }: { value: { code?: string; language?: string } }) => {
          const lang = value.language ? ` class="language-${escapeHtml(value.language)}"` : "";
          return `<pre><code${lang}>${escapeHtml(value.code ?? "")}</code></pre>`;
        },
        html: ({ value }: { value: { html?: string } }) => value.html ?? "",
      },
    },
    onMissingComponent: false,
  });
}
