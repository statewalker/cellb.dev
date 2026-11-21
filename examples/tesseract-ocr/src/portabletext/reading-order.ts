/**
 * Reading order of page items by recursive XY-cut.
 *
 * A region is split into columns where a vertical gutter (free of items)
 * runs through all of it, read left to right; otherwise into row bands at
 * horizontal gaps, read top to bottom. Before recursing, adjacent bands that
 * share a gutter are merged again: in a two-column body, paragraph breaks of
 * both columns can line up and cut the body into bands, which would otherwise
 * be read band by band (left, right, left, right…) instead of column by
 * column. A band whose content stops short of the gutter (the tail of a
 * longer column) merges with its neighbour too, so it stays in its column.
 */

export type OrderBox = { x: number; y: number; width: number; height: number };

export type ReadingOrderOptions = {
  /** Narrowest vertical whitespace treated as a column gutter (pt). */
  minGutter?: number;
};

type Interval = [number, number];

/** Free intervals of [lo, hi] not covered by any of the spans. */
function freeIntervals(spans: Interval[], lo: number, hi: number): Interval[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const free: Interval[] = [];
  let cursor = lo;
  for (const [s, e] of sorted) {
    if (s > cursor) free.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < hi) free.push([cursor, hi]);
  return free;
}

function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [a0, a1] of a) {
    for (const [b0, b1] of b) {
      const s = Math.max(a0, b0);
      const e = Math.min(a1, b1);
      if (e > s) out.push([s, e]);
    }
  }
  return out;
}

export function readingOrder(boxes: OrderBox[], options: ReadingOrderOptions = {}): number[] {
  const minGutter = options.minGutter ?? 6;
  const ids = boxes.map((_, i) => i);
  const xs = (i: number): Interval => [boxes[i].x, boxes[i].x + boxes[i].width];
  const ys = (i: number): Interval => [boxes[i].y, boxes[i].y + boxes[i].height];

  /** Gutters strictly inside the items' horizontal extent, wide enough. */
  function gutters(items: number[], lo: number, hi: number): Interval[] {
    return freeIntervals(items.map(xs), lo, hi).filter(
      ([s, e]) => e - s >= minGutter && s > lo && e < hi,
    );
  }

  function byPosition(items: number[]): number[] {
    return [...items].sort((a, b) => boxes[a].y - boxes[b].y || boxes[a].x - boxes[b].x);
  }

  function order(items: number[], depth: number): number[] {
    if (items.length <= 1 || depth > 32) return byPosition(items);
    const lo = Math.min(...items.map((i) => xs(i)[0]));
    const hi = Math.max(...items.map((i) => xs(i)[1]));

    // 1. Columns: a gutter through the whole region.
    const g = gutters(items, lo, hi);
    if (g.length > 0) {
      const cuts = g.map(([s, e]) => (s + e) / 2);
      const columns: number[][] = cuts.map(() => []);
      columns.push([]);
      for (const i of items) {
        const cx = boxes[i].x + boxes[i].width / 2;
        columns[cuts.filter((c) => c < cx).length].push(i);
      }
      return columns.filter((c) => c.length > 0).flatMap((c) => order(c, depth + 1));
    }

    // 2. Row bands at horizontal gaps.
    const top = Math.min(...items.map((i) => ys(i)[0]));
    const bottom = Math.max(...items.map((i) => ys(i)[1]));
    const gaps = freeIntervals(items.map(ys), top, bottom).filter(([s, e]) => e > s);
    if (gaps.length === 0) return byPosition(items);
    const cuts = gaps.map(([s, e]) => (s + e) / 2);
    let bands: number[][] = cuts.map(() => []);
    bands.push([]);
    for (const i of items) {
      const cy = boxes[i].y + boxes[i].height / 2;
      bands[cuts.filter((c) => c < cy).length].push(i);
    }
    bands = bands.filter((b) => b.length > 0);

    // 3. Merge neighbouring bands that share a gutter (columns cut into rows).
    const merged: number[][] = [];
    for (const band of bands) {
      const prev = merged[merged.length - 1];
      if (prev) {
        const shared = intersect(
          freeIntervals(prev.map(xs), lo, hi),
          freeIntervals(band.map(xs), lo, hi),
        ).filter(([s, e]) => e - s >= minGutter && s > lo && e < hi);
        // One of the two bands must already hold content on both sides of the shared gutter
        // (a column body; the other band may be a column's tail). Two one-sided bands (a
        // right-aligned date, then a short left line) are rows, not columns.
        const twoSided = (b: number[], s: number, e: number) =>
          b.some((i) => xs(i)[1] <= s) && b.some((i) => xs(i)[0] >= e);
        const both = shared.some(([s, e]) => twoSided(prev, s, e) || twoSided(band, s, e));
        if (both) {
          prev.push(...band);
          continue;
        }
      }
      merged.push([...band]);
    }
    if (merged.length === 1) {
      // Merging produced one region again: it now has a gutter through it.
      const again = gutters(merged[0], lo, hi);
      if (again.length === 0) return byPosition(items);
    }
    return merged.flatMap((b) => order(b, depth + 1));
  }

  return order(ids, 0);
}
