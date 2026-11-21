import type { KeyGen } from "./keys.ts";
import type { PageBox, Span, TableBlock, TextBlock } from "./schema.ts";

/** A text run from the PDF text layer, already in top-left page coordinates. */
export type TextRun = {
  str: string;
  x: number;
  /** Baseline y. */
  y: number;
  width: number;
  fontSize: number;
  hasEOL: boolean;
  /** Drawn in an invisible text rendering mode (typically an OCR layer over a scan). */
  invisible?: boolean;
  bold?: boolean;
  italic?: boolean;
};

/** A piece of text with one style. */
export type StyledText = { text: string; bold: boolean; italic: boolean };

export type ListInfo = { type: "bullet" | "number"; level: number };

export type Paragraph = {
  text: string;
  spans: StyledText[];
  fontSize: number;
  bbox: PageBox;
  list?: ListInfo;
};

export type Table = {
  rows: string[][];
  /** Leading rows set entirely in bold. */
  headerRows: number;
  fontSize: number;
  bbox: PageBox;
};

/** Styled text with its horizontal extent (absent on inserted spaces). */
type Segment = StyledText & { x0?: number; x1?: number };

type Line = {
  segments: Segment[];
  left: number;
  right: number;
  top: number;
  bottom: number;
  baseline: number;
  fontSize: number;
};

const lineText = (l: Line) => l.segments.map((s) => s.text).join("");

/** Bullet characters, or a number / letter / roman numeral followed by "." or ")". */
const BULLET = /^\s*([•◦▪▫‣⁃●○■□–—*·-])\s+/u;
const NUMBER = /^\s*(\(?(\d{1,3}|[a-zA-Z]|[ivxlcdm]{1,6})[.)])\s+/;
const MARKER_ONLY = /^\s*([•◦▪▫‣⁃●○■□–—*·-]|\(?(\d{1,3}|[a-zA-Z]|[ivxlcdm]{1,6})[.)])\s*$/u;

function listMarker(text: string): { type: ListInfo["type"]; length: number } | null {
  const bullet = text.match(BULLET);
  if (bullet) return { type: "bullet", length: bullet[0].length };
  const number = text.match(NUMBER);
  if (number) return { type: "number", length: number[0].length };
  return null;
}

function joinRuns(runs: TextRun[]): Line[] {
  const lines: Line[] = [];
  let line: Line | null = null;
  let last: TextRun | null = null;
  for (const run of runs) {
    // pdf.js inserts whitespace items to fill gaps between chunks, even across a
    // column gutter: they carry no geometry worth measuring.
    if (run.str.trim() === "" && !run.hasEOL) continue;
    // Same baseline and close: a wide gap means another column or table cell,
    // even when the PDF draws the two in one go. Super/subscripts are smaller
    // and shifted, so the tolerance follows the larger of the two sizes.
    const size = Math.max(run.fontSize, line?.fontSize ?? 0, 1);
    const sameLine =
      line !== null &&
      last !== null &&
      Math.abs(run.y - last.y) < size * 0.5 &&
      run.x - (last.x + last.width) < Math.max(run.fontSize, 1) * 1.5 &&
      run.x + run.width > last.x;
    if (!sameLine || line === null) {
      if (line) lines.push(line);
      line = {
        segments: [],
        left: run.x,
        right: run.x,
        top: run.y - run.fontSize,
        bottom: run.y + run.fontSize * 0.25,
        baseline: run.y,
        fontSize: run.fontSize,
      };
      last = null;
    }
    if (run.str.trim() !== "") {
      const style = { bold: !!run.bold, italic: !!run.italic };
      if (last) {
        const gap = run.x - (last.x + last.width);
        const text = lineText(line);
        const needsSpace = gap > run.fontSize * 0.15 && !/\s$/.test(text) && !/^\s/.test(run.str);
        if (needsSpace) line.segments.push({ text: " ", ...style });
      }
      line.segments.push({ text: run.str, ...style, x0: run.x, x1: run.x + run.width });
      line.left = Math.min(line.left, run.x);
      line.right = Math.max(line.right, run.x + run.width);
      line.top = Math.min(line.top, run.y - run.fontSize);
      line.bottom = Math.max(line.bottom, run.y + run.fontSize * 0.25);
      if (run.fontSize > line.fontSize) {
        line.fontSize = run.fontSize;
        line.baseline = run.y;
      }
      last = run;
    }
    if (run.hasEOL) {
      lines.push(line);
      line = null;
      last = null;
    }
  }
  if (line) lines.push(line);
  return lines.filter((l) => lineText(l).trim() !== "");
}

/**
 * A bullet or number drawn as its own item (e.g. followed by a tab) ends up
 * as a line of its own: put it back in front of the text on its baseline.
 */
function attachLoneMarkers(lines: Line[]): Line[] {
  const out = [...lines];
  for (const marker of lines) {
    if (!MARKER_ONLY.test(lineText(marker))) continue;
    const target = out
      .filter(
        (l) =>
          l !== marker &&
          Math.abs(l.baseline - marker.baseline) < marker.fontSize * 0.4 &&
          l.left > marker.right &&
          l.left - marker.right < marker.fontSize * 4,
      )
      .sort((a, b) => a.left - b.left)[0];
    if (!target) continue;
    target.segments.unshift({ ...marker.segments[0], text: `${lineText(marker).trim()} ` });
    target.left = marker.left;
    out.splice(out.indexOf(marker), 1);
  }
  return out;
}

/** How well `line` continues a paragraph ending with `prev` (lower is better), or null. */
function continuation(group: Line[], line: Line): number | null {
  const prev = group[group.length - 1];
  const gap = line.top - prev.bottom;
  const sizeRatio = line.fontSize / prev.fontSize;
  if (gap >= line.fontSize * 0.6 || gap <= -line.fontSize * 0.5) return null;
  if (sizeRatio <= 0.87 || sizeRatio >= 1.15) return null;
  const overlap = Math.min(prev.right, line.right) - Math.max(prev.left, line.left);
  const narrower = Math.min(prev.right - prev.left, line.right - line.left);
  if (overlap < narrower * 0.3) return null;
  // A list marker always starts a new item.
  if (listMarker(lineText(line))) return null;
  // Inside a list item, continuation lines are indented past the marker.
  if (listMarker(lineText(group[0])) && line.left < group[0].left + line.fontSize * 0.5)
    return null;
  return Math.abs(gap);
}

const plain = (s: StyledText) => !s.bold && !s.italic;
const sameStyle = (a: StyledText, b: StyledText) => a.bold === b.bold && a.italic === b.italic;

/**
 * Merges neighbouring pieces of the same style. Whitespace stays outside
 * marks: a space between two styled words of the same style joins them,
 * otherwise it is plain text ("**bold** and", not "**bold **and").
 */
function mergeSpans(spans: StyledText[]): StyledText[] {
  const pieces = spans.map((s) => ({ text: s.text, bold: s.bold, italic: s.italic }));
  for (let i = 0; i < pieces.length; i++) {
    const s = pieces[i];
    if (s.text.trim() !== "") continue;
    const prev = pieces[i - 1];
    const next = pieces[i + 1];
    const keep = prev && next && sameStyle(prev, next) ? prev : null;
    s.bold = keep ? keep.bold : false;
    s.italic = keep ? keep.italic : false;
  }
  // Move whitespace at the edges of styled pieces into the plain text next to them.
  const split: StyledText[] = [];
  for (const s of pieces) {
    if (plain(s) || s.text.trim() === "") {
      split.push(s);
      continue;
    }
    const lead = s.text.match(/^\s+/)?.[0] ?? "";
    const trail = s.text.match(/\s+$/)?.[0] ?? "";
    if (lead) split.push({ text: lead, bold: false, italic: false });
    split.push({ ...s, text: s.text.trim() });
    if (trail) split.push({ text: trail, bold: false, italic: false });
  }
  const out: StyledText[] = [];
  for (const s of split) {
    const prev = out[out.length - 1];
    if (prev && sameStyle(prev, s)) prev.text += s.text;
    else out.push({ ...s });
  }
  return out.map((s) => ({ ...s, text: s.text.replace(/\s+/g, " ") }));
}

function toParagraph(group: Line[]): Paragraph {
  const spans: StyledText[] = [];
  for (const line of group) {
    const segments = line.segments.map((s) => ({ ...s }));
    if (spans.length > 0) {
      const last = spans[spans.length - 1];
      const first = segments[0];
      // Rejoin words hyphenated across lines; otherwise lines are separated by a space.
      if (/\p{L}[-­]$/u.test(last.text) && /^\p{Ll}/u.test(first.text)) {
        last.text = last.text.slice(0, -1);
      } else {
        spans.push({ text: " ", bold: last.bold, italic: last.italic });
      }
    }
    spans.push(...segments);
  }
  let merged = mergeSpans(spans);
  // Trim the paragraph's outer whitespace.
  if (merged.length > 0) {
    merged[0].text = merged[0].text.replace(/^\s+/, "");
    merged[merged.length - 1].text = merged[merged.length - 1].text.replace(/\s+$/, "");
  }
  let list: ListInfo | undefined;
  const marker = listMarker(merged.map((s) => s.text).join(""));
  if (marker) {
    list = { type: marker.type, level: 1 };
    // Remove the marker from the start of the text.
    let remove = marker.length;
    for (const s of merged) {
      const cut = Math.min(remove, s.text.length);
      s.text = s.text.slice(cut);
      remove -= cut;
      if (remove === 0) break;
    }
  }
  merged = merged.filter((s) => s.text !== "");
  const left = Math.min(...group.map((l) => l.left));
  const top = Math.min(...group.map((l) => l.top));
  const right = Math.max(...group.map((l) => l.right));
  const bottom = Math.max(...group.map((l) => l.bottom));
  return {
    text: merged.map((s) => s.text).join(""),
    spans: merged,
    fontSize: Math.max(...group.map((l) => l.fontSize)),
    bbox: { x: left, y: top, width: right - left, height: bottom - top, unit: "pt" },
    ...(list ? { list } : {}),
  };
}

/** List levels from marker indentation: each distinct indent (±4 pt) is one level deeper. */
function assignListLevels(paragraphs: Paragraph[]): void {
  const items = paragraphs.filter((p) => p.list);
  const indents: number[] = [];
  for (const x of items.map((p) => p.bbox.x).sort((a, b) => a - b)) {
    if (indents.length === 0 || x - indents[indents.length - 1] > 4) indents.push(x);
  }
  for (const p of items) {
    const level = indents.filter((x) => x <= p.bbox.x + 4).length;
    if (p.list) p.list.level = Math.max(1, level);
  }
}

/** Longest text a table cell may have: longer ones are prose (e.g. two text columns side by side). */
const MAX_CELL_CHARS = 40;

/**
 * Finds simple tables: consecutive rows (lines sharing a baseline) of two or
 * more short cells whose horizontal positions line up with the columns of
 * the row that has the most cells.
 */
function detectTables(lines: Line[]): { tables: Table[]; used: Set<Line> } {
  // Rows: lines on (nearly) the same baseline, left to right.
  const rows: Line[][] = [];
  for (const line of [...lines].sort((a, b) => a.baseline - b.baseline)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].baseline - line.baseline) < line.fontSize * 0.4) row.push(line);
    else rows.push([line]);
  }
  for (const row of rows) row.sort((a, b) => a.left - b.left);
  const isCandidate = (row: Line[]) =>
    row.length >= 2 && row.every((l) => lineText(l).trim().length <= MAX_CELL_CHARS);

  const tables: Table[] = [];
  const used = new Set<Line>();
  let i = 0;
  while (i < rows.length) {
    if (!isCandidate(rows[i])) {
      i++;
      continue;
    }
    // Extend over following candidate rows that are close below.
    let j = i + 1;
    while (j < rows.length && isCandidate(rows[j])) {
      const prevBottom = Math.max(...rows[j - 1].map((l) => l.bottom));
      const top = Math.min(...rows[j].map((l) => l.top));
      if (top - prevBottom > rows[j][0].fontSize * 2) break;
      j++;
    }
    const block = rows.slice(i, j);
    i = j;
    if (block.length < 2) continue;
    // Columns: the extent of each cell over the rows with the most cells (header
    // cells set close together may have been joined into one line). Every row
    // must then put text into at least two of them.
    const most = Math.max(...block.map((r) => r.length));
    const full = block.filter((r) => r.length === most);
    const columns = full[0].map((_, k) => {
      const lefts = full.map((r) => r[k].left);
      const rights = full.map((r) => r[k].right);
      return [Math.min(...lefts), Math.max(...rights)] as [number, number];
    });
    const assign = (x0: number, x1: number) => {
      let best = 0;
      let bestScore = Number.NEGATIVE_INFINITY;
      columns.forEach(([s, e], k) => {
        // Overlap, or (negative) distance when the piece lies between columns.
        const score = Math.min(e, x1) - Math.max(s, x0);
        if (score > bestScore) {
          best = k;
          bestScore = score;
        }
      });
      return best;
    };
    // Cells are filled piece by piece, so a line spanning two columns is split.
    const grid = block.map((row) => {
      const cells: string[] = columns.map(() => "");
      for (const l of row) {
        let column = -1;
        let pendingSpace = false;
        for (const seg of l.segments) {
          if (seg.x0 === undefined || seg.x1 === undefined) {
            pendingSpace = true;
            continue;
          }
          const k = assign(seg.x0, seg.x1);
          const sep = cells[k] && (k !== column || pendingSpace) ? " " : "";
          cells[k] += sep + seg.text;
          column = k;
          pendingSpace = /\s$/.test(seg.text);
        }
      }
      return cells.map((c) => c.replace(/\s+/g, " ").trim());
    });
    const aligned = grid.every((cells) => cells.filter((c) => c !== "").length >= 2);
    if (!aligned || (columns.length < 3 && block.length < 3)) continue;
    const all = block.flat();
    for (const l of all) used.add(l);
    let headerRows = 0;
    while (
      headerRows < block.length &&
      block[headerRows].every((l) => l.segments.every((s) => s.bold || s.text.trim() === ""))
    ) {
      headerRows++;
    }
    if (headerRows === block.length) headerRows = 0;
    const left = Math.min(...all.map((l) => l.left));
    const top = Math.min(...all.map((l) => l.top));
    const right = Math.max(...all.map((l) => l.right));
    const bottom = Math.max(...all.map((l) => l.bottom));
    tables.push({
      rows: grid,
      headerRows,
      fontSize: Math.max(...all.map((l) => l.fontSize)),
      bbox: { x: left, y: top, width: right - left, height: bottom - top, unit: "pt" },
    });
  }
  return { tables, used };
}

/**
 * Lays out text-layer runs: tables first, then paragraphs (grouped by line
 * spacing, horizontal overlap and font size, whatever order the PDF drew the
 * lines in), with list items and bold / italic spans.
 */
export function layoutText(runs: TextRun[]): { paragraphs: Paragraph[]; tables: Table[] } {
  const lines = attachLoneMarkers(joinRuns(runs));
  const { tables, used } = detectTables(lines);
  const groups: Line[][] = [];
  const rest = lines.filter((l) => !used.has(l));
  for (const line of rest.sort((a, b) => a.top - b.top || a.left - b.left)) {
    let best: Line[] | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const group of groups) {
      const score = continuation(group, line);
      if (score !== null && score < bestScore) {
        best = group;
        bestScore = score;
      }
    }
    if (best) best.push(line);
    else groups.push([line]);
  }
  const paragraphs = groups.map(toParagraph).filter((p) => p.text !== "");
  assignListLevels(paragraphs);
  return { paragraphs, tables };
}

/** Paragraphs of the text layer (lines detected as tables are left out). */
export function groupTextRuns(runs: TextRun[]): Paragraph[] {
  return layoutText(runs).paragraphs;
}

/** Font size covering the most characters: the body text size. */
export function bodyFontSize(paragraphs: Paragraph[]): number {
  const weights = new Map<number, number>();
  for (const p of paragraphs) {
    const size = Math.round(p.fontSize * 2) / 2;
    weights.set(size, (weights.get(size) ?? 0) + p.text.length);
  }
  let best = 0;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  }
  return best || 10;
}

export function headingStyle(fontSize: number, bodySize: number, text: string): TextBlock["style"] {
  if (text.length > 200) return "normal";
  const ratio = fontSize / bodySize;
  if (ratio >= 1.6) return "h1";
  if (ratio >= 1.3) return "h2";
  if (ratio >= 1.15) return "h3";
  return "normal";
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function roundBox<T extends { x: number; y: number; width: number; height: number }>(
  b: T,
): T {
  return { ...b, x: r2(b.x), y: r2(b.y), width: r2(b.width), height: r2(b.height) };
}

export function paragraphToBlock(
  p: Paragraph,
  options: { keyGen: KeyGen; page: number; bodySize: number },
): TextBlock {
  const children: Span[] = p.spans.map((s) => ({
    _type: "span",
    _key: options.keyGen("s"),
    text: s.text,
    marks: [...(s.bold ? ["strong"] : []), ...(s.italic ? ["em"] : [])],
  }));
  // A paragraph set entirely in bold reads as a heading only by size; keep its marks.
  return {
    _type: "block",
    _key: options.keyGen("b"),
    style: p.list ? "normal" : headingStyle(p.fontSize, options.bodySize, p.text),
    ...(p.list ? { listItem: p.list.type, level: p.list.level } : {}),
    markDefs: [],
    children,
    source: { type: "pdfText", page: options.page, bbox: roundBox(p.bbox) },
  };
}

export function tableToBlock(t: Table, options: { keyGen: KeyGen; page: number }): TableBlock {
  return {
    _type: "table",
    _key: options.keyGen("t"),
    rows: t.rows.map((cells) => ({ _type: "tableRow", _key: options.keyGen("r"), cells })),
    ...(t.headerRows ? { headerRows: t.headerRows } : {}),
    source: { type: "pdfText", page: options.page, bbox: roundBox(t.bbox) },
  };
}
