import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { DOMParser, parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { buildPageModels } from "../src/page-models.js";
import {
  markdownToDocument,
  numberCells,
  type OutlineEntry,
  type PtCell,
  type PtTextBlock,
  parseInfo,
  proseToHtml,
} from "../src/portable-text.js";

const NOTEBOOK = `---
title: Features
---
# Features

Some *prose*, and the answer is \${answer}.

\`\`\`js echo
const answer = 6 * 7;
\`\`\`

\`\`\`js run=false
fetch("https://example.com") // shown, not run
\`\`\`

## Data

\`\`\`sql database=warehouse output=rows
SELECT 1
\`\`\`

\`\`\`python
print("inert")
\`\`\`

\`\`\`text
a plain code listing
\`\`\`

\`code \${not} an expression\`
`;

describe("parseInfo", () => {
  it("reads a fence's language and attributes", () => {
    expect(parseInfo('js echo run=false label="a b"')).toEqual({
      lang: "js",
      attrs: { echo: true, run: false, label: "a b" },
    });
    expect(parseInfo("sql database=warehouse output=rows").attrs).toEqual({
      database: "warehouse",
      output: "rows",
    });
  });
});

describe("markdownToDocument", () => {
  const doc = markdownToDocument(NOTEBOOK);

  it("makes cells of runnable fences, keeps other fences as code", () => {
    expect(doc.title).toBe("Features");
    const cells = doc.content.filter((b) => b._type === "cell") as PtCell[];
    expect(cells.map((c) => [c.mode, c.attrs])).toEqual([
      ["js", { echo: true }],
      ["js", { run: false }],
      ["sql", { database: "warehouse", output: "rows" }],
      ["python", {}],
    ]);
    expect(doc.content.some((b) => b._type === "code" && b.language === "text")).toBe(true);
  });

  it("splits ${…} out of prose, not out of inline code", () => {
    const para = doc.content.find(
      (b) => b._type === "block" && (b as PtTextBlock).children.some((c) => c._type === "expr"),
    ) as PtTextBlock;
    expect(para.children.map((c) => c._type)).toEqual(["span", "span", "span", "expr", "span"]);
    const code = doc.content.at(-1) as PtTextBlock;
    expect(code.children.every((c) => c._type === "span")).toBe(true);
  });

  it("gives the same keys for the same notebook", () => {
    expect(markdownToDocument(NOTEBOOK)).toEqual(doc);
    expect(doc.content.map((b) => b._key).slice(0, 3)).toEqual(["b0", "b1", "b2"]);
  });

  it("numbers cells and expressions in document order", () => {
    const { cells } = numberCells(doc);
    expect(cells.map((c) => [c.id, c.mode, c.value])).toEqual([
      [1, "js", "answer"],
      [2, "js", "const answer = 6 * 7;"],
      [3, "js", 'fetch("https://example.com") // shown, not run'],
      [4, "sql", "SELECT 1"],
      [5, "python", 'print("inert")'],
    ]);
    expect(cells[3]).toMatchObject({ database: "warehouse", output: "rows" });
  });

  it("renders prose with heading ids, an outline and expression spans", () => {
    const { content } = numberCells(doc);
    const outline: OutlineEntry[] = [];
    const html = proseToHtml(
      content.filter((b) => b._type === "block"),
      outline,
      new Set(),
    );
    expect(html).toContain('<h1 id="features">Features</h1>');
    expect(html).toContain('<h2 id="data">Data</h2>');
    expect(html).toContain('the answer is <span id="cell-1" class="expr"></span>.');
    expect(outline.map((o) => o.slug)).toEqual(["features", "data"]);
  });
});

describe("buildPageModels", () => {
  const moduleServer = {
    resolve: async (ref: { pkg: string; subpath?: string }) => ({
      url: `/m/${ref.pkg}@1.0.0/${ref.subpath ?? "index"}.js`,
      target: "browser",
    }),
  };
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const dom = { document, parser: new DOMParser() } as never;

  it("builds a page from a Markdown notebook: echo, run=false, expressions, SQL attributes", async () => {
    const notebooks = new MemFilesApi({ initialFiles: { "/features.md": NOTEBOOK } });
    const models = await buildPageModels({
      notebooks,
      moduleServer,
      dom,
      siteTitle: "S",
      base: "/t",
    });
    expect(models.failures).toEqual([]);
    const page = models.pages[0];
    expect(page).toMatchObject({ id: "features", path: "/t/features", title: "Features" });
    const cells = page?.blocks.filter((b) => b.kind === "cell");
    expect(cells).toEqual([
      { kind: "cell", id: 2, source: "const answer = 6 * 7;", mode: "js" },
      {
        kind: "cell",
        id: 3,
        source: 'fetch("https://example.com") // shown, not run',
        mode: "js",
        run: false,
      },
      { kind: "cell", id: 4 },
    ]);
    // the inert python cell and the text listing are prose; the expression has a span
    const prose = page?.blocks
      .filter((b) => b.kind === "prose")
      .map((b) => (b as { html: string }).html)
      .join("");
    expect(prose).toContain('<code class="language-python">print(&quot;inert&quot;)</code>');
    expect(prose).toContain('<span id="cell-1" class="expr"></span>');
    // defines: cells 2 and 4, and the expression 1; not the run=false cell 3
    const ids = [...(page?.script ?? "").matchAll(/getElementById\("cell-(\d+)"\)/g)].map(
      (m) => m[1],
    );
    expect(ids.sort()).toEqual(["1", "2", "4"]);
    expect(page?.script).toContain('"output":"rows"');
    expect(page?.script).toContain("warehouse");
    expect(
      page?.script.startsWith(
        'import {define} from "/m/@observablehq/notebook-kit@1.0.0/runtime.js";',
      ),
    ).toBe(true);
    expect(page?.content.some((b) => b._type === "cell")).toBe(true);
    expect(models.inputs).toContain("answer");
  });

  it("builds a page from a Notebook Kit document, its indented Markdown cells as prose", async () => {
    const html = `<!doctype html>
<notebook>
  <title>Kit</title>
  <script id="1" type="text/markdown">
    # Kit notebook

    A paragraph with \${n} in it.
  </script>
  <script id="2" type="module">
    const n = 3;
  </script>
</notebook>`;
    const notebooks = new MemFilesApi({ initialFiles: { "/kit.html": html } });
    const models = await buildPageModels({ notebooks, moduleServer, dom, siteTitle: "S" });
    expect(models.failures).toEqual([]);
    const page = models.pages[0];
    if (!page) throw new Error("no page");
    expect(page.title).toBe("Kit");
    const prose = (page.blocks[0] as { html: string }).html;
    expect(prose).toContain('<h1 id="kit-notebook">Kit notebook</h1>');
    expect(prose).toContain('A paragraph with <span id="cell-1" class="expr"></span> in it.');
    expect(page.blocks[1]).toEqual({ kind: "cell", id: 2 });
  });
});
