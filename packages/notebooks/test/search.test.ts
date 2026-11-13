// biome-ignore-all lint/suspicious/noTemplateCurlyInString: notebooks with `${…}` expressions, as plain strings
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { DOMParser, parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { buildPageModels } from "../src/page-models.js";
import { buildSearchIndex } from "../src/search.js";

const moduleServer = {
  resolve: async (ref: { pkg: string; subpath?: string }) => ({
    url: `/m/${ref.pkg}@1.0.0/${ref.subpath ?? "index"}.js`,
    target: "browser",
  }),
};
const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
const dom = { document, parser: new DOMParser() } as never;

describe("search index", () => {
  it("has one entry per section, with the page's anchors, and no code", async () => {
    const notebooks = new MemFilesApi({
      initialFiles: {
        "/index.md": "# Home\n\nWelcome to the *notebooks*.\n",
        "/guide.md": [
          "# Guide",
          "",
          "Intro text with ${value} and `inline code`.",
          "",
          "## Loading data",
          "",
          "Rows come from a **warehouse** table.",
          "",
          "```js",
          "const secretCellSource = 1;",
          "```",
          "",
          "## Loading data",
          "",
          "- a list item about charts",
        ].join("\n"),
      },
    });
    const models = await buildPageModels({
      notebooks,
      moduleServer,
      dom,
      siteTitle: "S",
      base: "/t",
      searchUrl: "/search.json",
    });
    expect(models.site.search).toBe("/search.json");
    const { pages, entries } = models.search;
    expect(pages).toEqual([
      { path: "/t/", title: "Home" },
      { path: "/t/guide", title: "Guide" },
    ]);
    const guide = entries.filter((e) => pages[e.p]?.title === "Guide");
    expect(guide.map((e) => [e.h, e.a])).toEqual([
      ["Guide", "guide"],
      ["Loading data", "loading-data"],
      ["Loading data", "loading-data-2"],
    ]);
    expect(guide[0]?.t).toBe("Intro text with and inline code.");
    expect(guide[1]?.t).toBe("Rows come from a warehouse table.");
    expect(guide[2]?.t).toBe("a list item about charts");
    expect(JSON.stringify(models.search)).not.toContain("secretCellSource");
    // the anchors are the page's heading ids
    const page = models.pages.find((p) => p.id === "guide");
    const html = page?.blocks.map((b) => (b.kind === "prose" ? b.html : "")).join("") ?? "";
    expect(html).toContain('<h2 id="loading-data-2">');
  });

  it("keeps wrapped lines apart and indexes a heading's words, not its Markdown", async () => {
    const notebooks = new MemFilesApi({
      initialFiles: {
        "/w.md": "# W\n\n## Use [Plot](https://x.com) `x`\n\nRows come from\na warehouse.\n",
      },
    });
    const models = await buildPageModels({ notebooks, moduleServer, dom, siteTitle: "S" });
    const entry = models.search.entries.find((e) => e.t.startsWith("Rows"));
    expect(entry).toMatchObject({ h: "Use Plot x", t: "Rows come from a warehouse." });
  });

  it("keeps a section's text bounded and drops empty untitled sections", () => {
    const index = buildSearchIndex([
      {
        path: "/p",
        title: "P",
        sections: [
          { heading: "", anchor: "", text: "" },
          { heading: "Long", anchor: "long", text: "x ".repeat(5000) },
        ],
      },
    ]);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]?.t.length).toBeLessThanOrEqual(2000);
  });
});
