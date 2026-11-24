/**
 * Source maps of a themed page's module script, back to the notebook's file (#235, step 3).
 *
 * - **Cell → file**: a `MagicString` over the notebook's text keeps exactly a cell's characters,
 *   line by line from its origins (a Notebook Kit cell's dedented indentation removed too), and
 *   is checked against the cell's source. A cell that does not rebuild gets no map.
 * - **Body → cell**: notebook-build's `map` (0.5), whose source is `cell-<id>`.
 * - **Script → body**: the script is a magic-string `Bundle` of the runtime import, the
 *   registrations and one `define()` per cell, each body its own source `cell-<id>.js`.
 * - `@jridgewell/remapping` composes them through a loader, so the page map's one source is the
 *   notebook file, with its text as `sourcesContent`.
 *
 * The error display (`errorObserver`) maps the first frame of the page script in a cell's error
 * stack itself, because browsers apply source maps only in devtools, not to `error.stack`. It
 * reads a table decoded from the map at build time (`positionTable`), so a page loads no
 * source-map library and the static export needs no extra module.
 */
import remapping, { type SourceMapInput } from "@jridgewell/remapping";
import { decode, encode, type SourceMapSegment } from "@jridgewell/sourcemap-codec";
import MagicString, { Bundle } from "magic-string";
import type { LineOrigin, Position } from "./portable-text.js";

export type SourceMap = {
  version: 3;
  sources: (string | null)[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
  file?: string;
};

/** Offsets of each line's start in `text`. */
function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) out.push(i + 1);
  return out;
}

/** The map from a cell's source to the notebook file, or `undefined` when it does not rebuild. */
export function cellToFileMap(
  fileText: string,
  starts: readonly number[],
  source: string,
  origin: LineOrigin,
  file: string,
): SourceMap | undefined {
  const lines = source.split("\n");
  const ranges: [number, number][] = [];
  for (const [k, text] of lines.entries()) {
    const { line, column } = origin(k);
    const lineStart = starts[line - 1];
    if (lineStart === undefined) return undefined;
    const from = lineStart + column - 1;
    ranges.push([from, from + text.length]);
  }
  const s = new MagicString(fileText);
  try {
    const first = ranges[0];
    const last = ranges[ranges.length - 1];
    if (!first || !last) return undefined;
    if (first[0] > 0) s.remove(0, first[0]);
    for (let k = 1; k < ranges.length; k++) {
      const gap: [number, number] = [ranges[k - 1]?.[1] ?? 0, ranges[k]?.[0] ?? 0];
      if (gap[1] <= gap[0]) return undefined;
      s.overwrite(gap[0], gap[1], "\n");
    }
    if (last[1] < fileText.length) s.remove(last[1], fileText.length);
  } catch {
    return undefined;
  }
  if (s.toString() !== source) return undefined;
  // Word boundaries, not every character: as precise for stack frames, much smaller.
  return s.generateMap({
    source: file,
    hires: "boundary",
    includeContent: true,
  }) as unknown as SourceMap;
}

/** A cell's origin from its first position only: later lines start at column 1. */
export const originFrom =
  (p: Position): LineOrigin =>
  (k) =>
    k === 0 ? p : { line: p.line + k, column: 1 };

/** One `define()` of the page script, its body a source of its own (`cell-<id>.js`). */
export interface ScriptCell {
  id: number;
  prefix: string;
  body: string;
  suffix: string;
  /** body → notebook file */
  map?: SourceMap;
}

/**
 * The page script and its map back to the notebook: `head` lines (unmapped), each cell's
 * `define()`, then `tail` (unmapped), then the `sourceURL` and the inline map.
 */
export function pageScript(opts: {
  head: string[];
  cells: ScriptCell[];
  tail: (map: SourceMap) => string;
  sourceUrl: string;
}): string {
  const bundle = new Bundle({ separator: "\n" });
  for (const line of opts.head) bundle.addSource({ content: new MagicString(line) });
  const maps = new Map<string, SourceMap>();
  for (const cell of opts.cells) {
    const s = new MagicString(cell.body).prepend(cell.prefix).append(cell.suffix);
    if (!cell.map) {
      // No map to the notebook: no source, so no mappings that would point elsewhere.
      bundle.addSource({ content: s });
      continue;
    }
    const filename = `cell-${cell.id}.js`;
    bundle.addSource({ filename, content: s });
    maps.set(filename, cell.map);
  }
  // No `file`: magic-string would write the sources relative to it, and the loader matches names.
  const generated = bundle.generateMap({ hires: "boundary", includeContent: false });
  let map: SourceMap;
  try {
    map = remapping(generated as unknown as SourceMapInput, (file) => maps.get(file) ?? null, {
      excludeContent: false,
    }) as unknown as SourceMap;
  } catch {
    map = { version: 3, sources: [], names: [], mappings: "" };
  }
  // Sources no cell map resolved (`cell-<id>.js` of an unmapped cell) stay as they are.
  map.mappings = compactRuns(map.mappings);
  map.file = opts.sourceUrl;
  const withoutContent = { ...map, sourcesContent: undefined };
  const code = `${bundle.toString()}\n${opts.tail(withoutContent)}`;
  const inline = Buffer.from(JSON.stringify(map)).toString("base64");
  return `${code}\n//# sourceURL=${opts.sourceUrl}\n//# sourceMappingURL=data:application/json;base64,${inline}`;
}

/**
 * Mappings with one segment per run: a segment that continues the previous one on its line (same
 * source, same source line, same column offset) is dropped, since it maps the same way a reader
 * extrapolating from the run's start would. Segments without a source end a run and are kept.
 */
export function compactRuns(mappings: string): string {
  return encode(
    decode(mappings).map((segments) => {
      const out: SourceMapSegment[] = [];
      for (const s of segments) {
        const last = out[out.length - 1];
        if (
          last &&
          s.length >= 4 &&
          last.length >= 4 &&
          s[1] === last[1] &&
          s[2] === last[2] &&
          (s[3] ?? 0) - s[0] === (last[3] ?? 0) - last[0] &&
          s.length === last.length
        )
          continue;
        out.push(s);
      }
      return out;
    }),
  );
}

/**
 * The map's mappings into `source` as a lookup table: for each generated line (1-based) with
 * segments, rows `[generated column (0-based), source line (1-based), source column (0-based)]`
 * sorted by column, one row where a run starts: a segment that continues the previous one (same
 * source line, same column offset) adds none, and a lookup extrapolates within the run.
 */
export function positionTable(
  map: SourceMap,
  source: string,
): Record<number, [number, number, number][]> {
  const index = map.sources.indexOf(source);
  const table: Record<number, [number, number, number][]> = {};
  if (index < 0) return table;
  for (const [i, segments] of decode(map.mappings).entries()) {
    const rows: [number, number, number][] = [];
    for (const s of segments) {
      if (s.length < 4) continue;
      const last = rows[rows.length - 1];
      // A segment into another source (an unmapped cell's body) ends the run: no row covers it.
      if (s[1] !== index) {
        if (last && last[1] !== -1) rows.push([s[0], -1, 0]);
        continue;
      }
      const row: [number, number, number] = [s[0], (s[2] ?? 0) + 1, s[3] ?? 0];
      if (last && last[1] === row[1] && last[2] - last[0] === row[2] - row[0]) continue;
      rows.push(row);
    }
    if (rows.some((r) => r[1] !== -1)) table[i + 1] = rows;
  }
  return table;
}

/**
 * The error display: an observer around notebook-kit's `observe` that adds the notebook position
 * of the first page-script frame of a cell's error (`features.md:12:7`) under the error, looked up
 * in the page's position table (the run at or before the frame's column on its line).
 */
export function errorObserver(sourceUrl: string, map: SourceMap, notebook: string): string {
  const name = sourceUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const file = notebook.replace(/^\//, "");
  return [
    `const __positions = ${JSON.stringify(positionTable(map, notebook))};`,
    "function __observe(state, definition) {",
    "  const o = observe(state, definition);",
    "  const rejected = o.rejected;",
    "  o.rejected = function (error) {",
    "    rejected.call(this, error);",
    "    const where = __locate(error);",
    "    if (!where) return;",
    '    const el = document.createElement("div");',
    '    el.className = "cell-position";',
    "    el.textContent = where;",
    "    state.root.append(el);",
    "  };",
    "  return o;",
    "}",
    "function __locate(error) {",
    `  const m = new RegExp(${JSON.stringify(`${name}:(\\d+):(\\d+)`)}).exec(String(error && error.stack || ""));`,
    "  const rows = m && __positions[m[1]];",
    "  if (!rows) return undefined;",
    "  const column = Number(m[2]) - 1;",
    "  let found;",
    "  for (const row of rows) if (row[0] <= column) found = row;",
    "  if (!found || found[1] < 0) return undefined;",
    `  return ${JSON.stringify(file)} + ":" + found[1] + ":" + (found[2] + column - found[0] + 1);`,
    "}",
  ].join("\n");
}

export { lineStarts };
