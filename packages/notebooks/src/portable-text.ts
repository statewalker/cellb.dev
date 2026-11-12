/**
 * Notebooks as documents: the form a page model is made from (docs/notebook-runtime/options.md in
 * statewalker-sandbox, Section 2: Portable Text as the document IR, notebook-kit's `Notebook`
 * derived from it as the executable IR).
 *
 * A notebook is a sequence of parts:
 *
 * - a **code cell**: a top-level fence whose language is a notebook-kit cell mode (` ```js `,
 *   ` ```sql `, and the modes that do not run in a page: `html`, `tex`, `dot`, …), with the
 *   attributes of its info string (` ```js echo `, ` ```js run=false `,
 *   ` ```sql database=warehouse output=rows `);
 * - **prose**: the Markdown between them, its `${…}` expressions taken out first.
 *
 * Expressions are found in the raw Markdown, before any Markdown parsing, by a scanner that knows
 * JavaScript strings, template literals and comments, skips code spans and honours `\${`. Each is
 * replaced by a placeholder, so Markdown never sees (or mangles) its source: `${x*2}` stays an
 * expression, not emphasis. Prose is rendered from its Markdown with markdown-it, as before (images,
 * tables, inline HTML), the placeholders becoming the `<span>`s the expressions display into.
 *
 * The Portable Text form (`toPortableText`) is the document as data, for the page model's
 * `content`: prose as `@portabletext/markdown` blocks with `expr` inline objects where the
 * placeholders were, and `code-cell` block objects. Keys are deterministic at every depth, so the
 * same notebook gives the same document.
 */
import type { Notebook } from "@observablehq/notebook-kit";
import { markdownToPortableText } from "@portabletext/markdown";
import MarkdownIt from "markdown-it";

export interface CellAttrs {
  echo?: boolean;
  run?: boolean;
  hidden?: boolean;
  database?: string;
  output?: string;
  [name: string]: string | boolean | undefined;
}

/** A code cell, as a part and as a Portable Text block object. */
export interface CodeCell {
  _type: "code-cell";
  _key: string;
  mode: string;
  source: string;
  attrs: CellAttrs;
  id?: number;
}

export interface ProsePart {
  kind: "prose";
  /** The Markdown, each expression replaced by a placeholder (`placeholder(n)`). */
  markdown: string;
  /** The expressions' sources, in order: placeholder `n` is `exprs[n]`. */
  exprs: string[];
}
export interface CellPart {
  kind: "cell";
  cell: CodeCell;
}
export type Part = ProsePart | CellPart;

export interface NotebookDocument {
  title?: string;
  /** notebook-kit's theme name (front matter `theme:`, or a Notebook Kit document's). */
  theme?: unknown;
  parts: Part[];
}

/** A part with its cells and expressions numbered. */
export type NumberedPart =
  | { kind: "prose"; markdown: string; exprs: { id: number; source: string }[] }
  | { kind: "cell"; cell: CodeCell & { id: number } };

export type PtBlock = { _type: string; _key: string; [k: string]: unknown };

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

/** Private-use characters: Markdown leaves them as text, HTML escaping leaves them alone. */
const PH_OPEN = "";
const PH_CLOSE = "";
const PLACEHOLDER = /(\d+)/g;
export const placeholder = (n: number) => `${PH_OPEN}${n}${PH_CLOSE}`;

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

/**
 * The index just after the `}` closing a JavaScript expression that starts at `from` (just after
 * a `${`), or -1 when it never closes. Knows strings, template literals (nested `${}` included),
 * and comments; not regular-expression literals.
 */
export function scanExpression(src: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') {
      i = skipString(src, i, c);
      if (i < 0) return -1;
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i);
      if (i < 0) return -1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) return -1;
      i = nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 2;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      if (depth === 0) return i + 1;
      depth--;
    }
    i++;
  }
  return -1;
}

function skipString(src: string, at: number, quote: string): number {
  for (let i = at + 1; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === quote) return i + 1;
    else if (src[i] === "\n") return -1;
  }
  return -1;
}

function skipTemplate(src: string, at: number): number {
  for (let i = at + 1; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "`") return i + 1;
    else if (src[i] === "$" && src[i + 1] === "{") {
      const end = scanExpression(src, i + 2);
      if (end < 0) return -1;
      i = end - 1;
    }
  }
  return -1;
}

/**
 * Takes the `${…}` expressions out of Markdown prose: each becomes `placeholder(n)`. Code spans
 * (`` `…${x}…` ``) are left alone, `\${` stays a literal (Markdown then shows `${`), and an
 * unterminated `${` stays text.
 */
export function extractExpressions(markdown: string): { markdown: string; exprs: string[] } {
  const exprs: string[] = [];
  let out = "";
  let i = 0;
  while (i < markdown.length) {
    const c = markdown[i];
    if (c === "\\" && markdown[i + 1] === "$") {
      out += "\\$";
      i += 2;
      continue;
    }
    if (c === "`") {
      // A code span: from a run of N backticks to the next run of exactly N.
      let n = 0;
      while (markdown[i + n] === "`") n++;
      const fence = "`".repeat(n);
      let end = markdown.indexOf(fence, i + n);
      while (end >= 0 && markdown[end + n] === "`") end = markdown.indexOf(fence, end + n + 1);
      const stop = end < 0 ? i + n : end + n;
      out += markdown.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "$" && markdown[i + 1] === "{") {
      const end = scanExpression(markdown, i + 2);
      if (end > 0) {
        exprs.push(markdown.slice(i + 2, end - 1).trim());
        out += placeholder(exprs.length - 1);
        i = end;
        continue;
      }
    }
    out += c;
    i++;
  }
  return { markdown: out, exprs };
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

const md = new MarkdownIt({ html: true });

function prosePart(markdown: string): ProsePart | undefined {
  if (!markdown.trim()) return undefined;
  return { kind: "prose", ...extractExpressions(markdown) };
}

/** Text of a heading's source with the placeholders shown as their `${…}`. */
const showExprs = (text: string, exprs: readonly string[]) =>
  text.replace(PLACEHOLDER, (_, n) => `\${${exprs[Number(n)] ?? ""}}`);

/** A Markdown notebook as a document: top-level cell-mode fences are cells, the rest prose. */
export function markdownToDocument(source: string): NotebookDocument {
  const { meta, body } = splitFrontMatter(source);
  const lines = body.split("\n");
  const parts: Part[] = [];
  let from = 0;
  let title: string | undefined = meta.title;
  const tokens = md.parse(body, {});
  for (const [i, token] of tokens.entries()) {
    if (token.level !== 0 || !token.map) continue;
    if (title === undefined && token.type === "heading_open" && token.tag === "h1")
      title = tokens[i + 1]?.content.trim();
    if (token.type !== "fence") continue;
    const { lang, attrs } = parseInfo(token.info ?? "");
    const mode = FENCE_MODES[lang];
    if (!mode) continue;
    const prose = prosePart(lines.slice(from, token.map[0]).join("\n"));
    if (prose) parts.push(prose);
    const cellSource = token.content.replace(/\n$/, "");
    parts.push({
      kind: "cell",
      cell: { _type: "code-cell", _key: "", mode, source: cellSource, attrs },
    });
    from = token.map[1];
  }
  const rest = prosePart(lines.slice(from).join("\n"));
  if (rest) parts.push(rest);
  // The title is plain text: an expression in the h1 shows as its source.
  return {
    parts,
    ...(title ? { title } : {}),
    ...(meta.theme ? { theme: meta.theme } : {}),
  };
}

/**
 * A notebook-kit `Notebook` (a Notebook Kit `.html` document) as a document: `md` cells are prose
 * (their `${…}` expressions, as notebook-kit's md template literals have them), the others cells.
 * `pinned` (notebook-kit's "show the source") is `echo`; `hidden` hides the cell's output.
 */
export function notebookToDocument(nb: Notebook): NotebookDocument {
  const parts: Part[] = [];
  for (const cell of nb.cells) {
    if (cell.mode === "md") {
      const prose = prosePart(cell.value);
      if (prose) parts.push(prose);
      continue;
    }
    const attrs: CellAttrs = {};
    if (cell.output) attrs.output = cell.output;
    if (cell.database) attrs.database = cell.database;
    if (cell.pinned) attrs.echo = true;
    if (cell.hidden) attrs.hidden = true;
    parts.push({
      kind: "cell",
      cell: { _type: "code-cell", _key: "", mode: cell.mode, source: cell.value, attrs },
    });
  }
  return { parts, title: nb.title, ...(nb.theme ? { theme: nb.theme } : {}) };
}

/** A cell spec as notebook-kit's `toNotebook` takes it. */
export interface CellSpecLite {
  id: number;
  mode: string;
  value: string;
  output?: string;
  database?: string;
}

/**
 * Numbers the document's cells and expressions in document order (1, 2, …: notebook-kit treats a
 * cell id that is not a positive integer as absent) and returns the cell specs notebook-kit's
 * transpiler takes: one per code cell, one `js` cell per expression.
 */
export function numberCells(doc: NotebookDocument): {
  parts: NumberedPart[];
  cells: CellSpecLite[];
} {
  let id = 1;
  const cells: CellSpecLite[] = [];
  const parts = doc.parts.map((part): NumberedPart => {
    if (part.kind === "cell") {
      const c = part.cell;
      const numbered = { ...c, id: id++ };
      cells.push({
        id: numbered.id,
        mode: c.mode,
        value: c.source,
        ...(typeof c.attrs.output === "string" ? { output: c.attrs.output } : {}),
        ...(typeof c.attrs.database === "string" ? { database: c.attrs.database } : {}),
      });
      return { kind: "cell", cell: numbered };
    }
    const exprs = part.exprs.map((source) => {
      const e = { id: id++, source };
      cells.push({ id: e.id, mode: "js", value: source });
      return e;
    });
    return { kind: "prose", markdown: part.markdown, exprs };
  });
  return { parts, cells };
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

/** A page section for the search index: the text under one heading (`anchor` its id). */
export interface SearchSection {
  heading: string;
  anchor: string;
  text: string;
}

/**
 * Prose → HTML with markdown-it: headings get ids (collected into `outline`), each expression's
 * placeholder becomes the `<span id="cell-<id>">` its cell displays into, or the error of an
 * expression that does not compile. A placeholder inside a tag (an attribute value) shows its
 * source as text: a span cannot go there.
 */
export function renderProse(
  part: Extract<NumberedPart, { kind: "prose" }>,
  outline: OutlineEntry[],
  used: Set<string>,
  errors: ReadonlyMap<number, string> = new Map(),
  /** Collects the prose's text by section, for the search index; the last entry is the current one. */
  sections?: SearchSection[],
): string {
  const sources = part.exprs.map((e) => e.source);
  const tokens = md.parse(part.markdown, {});
  for (const [i, t] of tokens.entries()) {
    if (sections && t.type === "inline" && tokens[i - 1]?.type !== "heading_open") {
      const words = (t.children ?? [])
        .filter((c) => c.type === "text" || c.type === "code_inline")
        .map((c) => c.content.replace(PLACEHOLDER, " "))
        .join("");
      const current = sections.at(-1);
      if (current && words.trim()) current.text += `${current.text ? " " : ""}${words.trim()}`;
    }
    if (t.type !== "heading_open") continue;
    const raw = tokens[i + 1]?.content ?? "";
    const text = showExprs(raw, sources);
    const base = slugify(raw.replace(PLACEHOLDER, "")) || "section";
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    t.attrSet("id", slug);
    outline.push({ depth: Number(t.tag.slice(1)), text, slug });
    sections?.push({ heading: raw.replace(PLACEHOLDER, "").trim(), anchor: slug, text: "" });
  }
  const html = md.renderer.render(tokens, md.options, {});
  return html.replace(/<[^>]*>|(\d+)/g, (match, n?: string) => {
    if (n === undefined) {
      // a tag: placeholders inside it (attribute values) become their source
      return match.replace(PLACEHOLDER, (_, k) => escapeHtml(`\${${sources[Number(k)] ?? ""}}`));
    }
    const expr = part.exprs[Number(n)];
    if (!expr) return "";
    const error = errors.get(expr.id);
    return error === undefined
      ? `<span id="cell-${expr.id}" class="expr"></span>`
      : `<span id="cell-${expr.id}" class="expr cell-error">${escapeHtml(error)}</span>`;
  });
}

/** Rewrites every `_key` by its path (`b0`, `b0.1`, …), and mark references with their defs. */
function rekey<T>(node: T, key: string): T {
  if (Array.isArray(node)) return node.map((n, i) => rekey(n, `${key}.${i}`)) as T;
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  const defs = new Map<string, string>();
  const out: Record<string, unknown> = {};
  if (Array.isArray(obj.markDefs))
    out.markDefs = (obj.markDefs as { _key: string }[]).map((d, m) => {
      defs.set(d._key, `${key}m${m}`);
      return { ...rekey(d, `${key}m${m}`), _key: `${key}m${m}` };
    });
  for (const [k, v] of Object.entries(obj)) {
    if (k === "markDefs") continue;
    if (k === "_key") out._key = key;
    else if (k === "children" && Array.isArray(v))
      out.children = v.map((c: Record<string, unknown>, i: number) => {
        const child = rekey(c, `${key}s${i}`);
        return Array.isArray(child.marks)
          ? { ...child, marks: (child.marks as string[]).map((x) => defs.get(x) ?? x) }
          : child;
      });
    else out[k] = rekey(v, k === "_key" ? key : `${key}.${k}`);
  }
  return out as T;
}

/** Splits placeholders out of every span, at any depth (table cells included), into `expr`s. */
function splitPlaceholders<T>(node: T, exprs: readonly { id: number; source: string }[]): T {
  if (Array.isArray(node)) return node.map((n) => splitPlaceholders(n, exprs)) as T;
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "children" && Array.isArray(v) && obj._type === "block") {
      out.children = v.flatMap((c: Record<string, unknown>) => {
        if (c._type !== "span" || typeof c.text !== "string" || !c.text.includes(PH_OPEN))
          return [splitPlaceholders(c, exprs)];
        const pieces: Record<string, unknown>[] = [];
        let last = 0;
        for (const m of c.text.matchAll(PLACEHOLDER)) {
          const at = m.index ?? 0;
          if (at > last) pieces.push({ ...c, text: c.text.slice(last, at) });
          const e = exprs[Number(m[1])];
          if (e) pieces.push({ _type: "expr", _key: "", id: e.id, source: e.source });
          last = at + m[0].length;
        }
        if (last < c.text.length) pieces.push({ ...c, text: c.text.slice(last) });
        return pieces;
      });
    } else out[k] = splitPlaceholders(v, exprs);
  }
  return out as T;
}

/**
 * The document as Portable Text: prose as `@portabletext/markdown` blocks with `expr` inline
 * objects (`id`, `source`) where the expressions were, code cells as `code-cell` block objects.
 * Keys are deterministic at every depth.
 */
export function toPortableText(parts: readonly NumberedPart[]): PtBlock[] {
  const blocks: PtBlock[] = [];
  for (const part of parts) {
    if (part.kind === "cell") blocks.push(part.cell as unknown as PtBlock);
    else
      blocks.push(
        ...splitPlaceholders(
          markdownToPortableText(part.markdown) as unknown as PtBlock[],
          part.exprs,
        ),
      );
  }
  return blocks.map((b, i) => rekey(b, `b${i}`));
}
