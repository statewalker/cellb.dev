/**
 * A site's search index: one entry per page section (the text under a heading), small enough
 * to fetch whole and search in the page. The theme loads it on first use; an export carries it.
 * Sections come from `renderProse`, the same pass that gives headings their ids, so an entry's
 * `a` is an anchor the page has.
 */
import type { SearchSection } from "./portable-text.js";

export interface SearchIndex {
  /** The pages, by index: their path and title. */
  pages: { path: string; title: string }[];
  /** `p` the page's index, `h` the heading (empty above the first), `a` its anchor, `t` its text. */
  entries: { p: number; h: string; a: string; t: string }[];
}

/** Text kept per section: enough to match on, without carrying whole pages twice. */
const MAX_TEXT = 2000;

export function buildSearchIndex(
  pages: readonly { path: string; title: string; sections: readonly SearchSection[] }[],
): SearchIndex {
  const index: SearchIndex = { pages: [], entries: [] };
  for (const [p, page] of pages.entries()) {
    index.pages.push({ path: page.path, title: page.title });
    for (const s of page.sections) {
      const t = s.text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
      if (!t && !s.anchor) continue;
      index.entries.push({ p, h: s.heading, a: s.anchor, t });
    }
  }
  return index;
}
