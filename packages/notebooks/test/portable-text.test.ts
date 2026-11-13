// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these tests feed `${…}` expressions to the notebook parser as plain strings
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { DOMParser, parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { buildPageModels } from "../src/page-models.js";
import {
  extractExpressions,
  markdownToDocument,
  type NumberedPart,
  numberCells,
  type OutlineEntry,
  parseInfo,
  placeholder,
  renderProse,
  toPortableText,
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
a plain code listing with \${not} an expression
\`\`\`

\`code \${not} an expression\`
`;

const prose = (parts: NumberedPart[]) =>
  parts.filter((p): p is Extract<NumberedPart, { kind: "prose" }> => p.kind === "prose");

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

describe("extractExpressions", () => {
  const exprs = (md: string) => extractExpressions(md).exprs;

  it("takes expressions out before Markdown can read them", () => {
    expect(exprs("${x*2} b ${a*b*c}")).toEqual(["x*2", "a*b*c"]);
    expect(exprs("${html`<b>${x}</b>`}")).toEqual(["html`<b>${x}</b>`"]);
    expect(exprs("${'http://example.com'}")).toEqual(["'http://example.com'"]);
    expect(exprs('${"<b>hi</b>"}')).toEqual(['"<b>hi</b>"']);
    expect(exprs('${"}"} after')).toEqual(['"}"']);
    expect(exprs("${ {a: 1}.a /* } */ }")).toEqual(["{a: 1}.a /* } */"]);
  });

  it("leaves code spans, \\${ and unterminated ${ alone", () => {
    expect(exprs("`code ${x}` and ``a ` ${y} b``")).toEqual([]);
    const escaped = extractExpressions("text \\${x}");
    expect(escaped.exprs).toEqual([]);
    expect(escaped.markdown).toBe("text \\${x}");
    expect(exprs("open ${ never closes")).toEqual([]);
  });

  it("replaces each by a placeholder", () => {
    expect(extractExpressions("a ${b} c ${d}").markdown).toBe(
      `a ${placeholder(0)} c ${placeholder(1)}`,
    );
  });
});

describe("markdownToDocument", () => {
  const doc = markdownToDocument(NOTEBOOK);

  it("makes cells of top-level cell-mode fences, keeps other fences in the prose", () => {
    expect(doc.title).toBe("Features");
    const cells = doc.parts.flatMap((p) => (p.kind === "cell" ? [p.cell] : []));
    expect(cells.map((c) => [c.mode, c.attrs])).toEqual([
      ["js", { echo: true }],
      ["js", { run: false }],
      ["sql", { database: "warehouse", output: "rows" }],
      ["python", {}],
    ]);
    const text = doc.parts.flatMap((p) => (p.kind === "prose" ? [p.markdown] : [])).join("\n");
    expect(text).toContain("```text\na plain code listing with ${not} an expression\n```");
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
    const outline: OutlineEntry[] = [];
    const used = new Set<string>();
    const html = prose(numberCells(doc).parts)
      .map((p) => renderProse(p, outline, used))
      .join("");
    expect(html).toContain('<h1 id="features">Features</h1>');
    expect(html).toContain('<h2 id="data">Data</h2>');
    expect(html).toContain('the answer is <span id="cell-1" class="expr"></span>.');
    expect(html).toContain("<code>code ${not} an expression</code>");
    expect(outline.map((o) => o.slug)).toEqual(["features", "data"]);
  });
});

describe("renderProse", () => {
  const render = (md: string, errors?: Map<number, string>) =>
    prose(numberCells(markdownToDocument(md)).parts)
      .map((p) => renderProse(p, [], new Set(), errors))
      .join("");

  it("keeps what markdown-it renders: images, tables, rules, inline HTML", () => {
    const html = render(
      "![alt](a.png)\n\n| a | b |\n|---|---|\n| 1 | ${x} |\n\n---\n\nhi <b>bold</b> <kbd>K</kbd>",
    );
    expect(html).toContain('<img src="a.png" alt="alt">');
    expect(html).toContain("<table>");
    expect(html).toContain('<td><span id="cell-1" class="expr"></span></td>');
    expect(html).toContain("<hr>");
    expect(html).toContain("hi <b>bold</b> <kbd>K</kbd>");
    expect(html).not.toContain("Unknown block type");
  });

  it("puts an expression in a link's text inside the link, and shows one in an attribute as text", () => {
    expect(render("[link ${x}](url)")).toContain(
      '<a href="url">link <span id="cell-1" class="expr"></span></a>',
    );
    expect(render("<a title='${x}'>t</a>")).toContain("<a title='${x}'>t</a>");
  });

  it("shows the error of an expression that does not compile", () => {
    const html = render("a ${x} b", new Map([[1, "SyntaxError: nope <here>"]]));
    expect(html).toContain(
      '<span id="cell-1" class="expr cell-error">SyntaxError: nope &lt;here&gt;</span>',
    );
  });
});

describe("toPortableText", () => {
  it("gives code-cell objects and expr objects, at every depth, with the same keys each time", () => {
    const md = "# T\n\nA ${x}.\n\n| a |\n|---|\n| ${y} |\n\n```js\n1\n```\n";
    const content = () => toPortableText(numberCells(markdownToDocument(md)).parts);
    const json = JSON.stringify(content());
    expect(JSON.stringify(content())).toBe(json);
    expect(json).toContain('"_type":"code-cell"');
    expect(json).toContain('"_type":"expr","_key"');
    expect(json).toContain('"id":1,"source":"x"');
    expect(json).toContain('"id":2,"source":"y"'); // inside the table
    expect(json).not.toContain("");
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
    if (!page) throw new Error("no page");
    expect(page).toMatchObject({ id: "features", path: "/t/features", title: "Features" });
    expect(page.blocks.filter((b) => b.kind === "cell")).toEqual([
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
    const html = page.blocks.map((b) => (b.kind === "prose" ? b.html : "")).join("");
    expect(html).toContain('<code class="language-python">print(&quot;inert&quot;)</code>');
    expect(html).toContain('<span id="cell-1" class="expr"></span>');
    // defines: cells 2 and 4, and the expression 1; not the run=false cell 3
    const ids = [...page.script.matchAll(/getElementById\("cell-(\d+)"\)/g)].map((m) => m[1]);
    expect(ids.sort()).toEqual(["1", "2", "4"]);
    expect(page.script).toContain('"output":"rows"');
    expect(page.script).toContain("warehouse");
    expect(
      page.script.startsWith(
        'import {define} from "/m/@observablehq/notebook-kit@1.0.0/runtime.js";',
      ),
    ).toBe(true);
    expect(page.content.some((b) => b._type === "code-cell")).toBe(true);
    expect(models.inputs).toContain("answer");
  });

  it("shows a broken expression's error in place and does not define it", async () => {
    const notebooks = new MemFilesApi({ initialFiles: { "/b.md": "# B\n\nBroken: ${)}.\n" } });
    const models = await buildPageModels({ notebooks, moduleServer, dom, siteTitle: "S" });
    const page = models.pages[0];
    if (!page) throw new Error("no page");
    const html = (page.blocks[0] as { html: string }).html;
    expect(html).toMatch(/<span id="cell-1" class="expr cell-error">[^<]+<\/span>/);
    expect(page.script).not.toContain('getElementById("cell-1")');
  });

  it("builds a page from a Notebook Kit document: indented prose, pinned, hidden", async () => {
    const html = `<!doctype html>
<notebook>
  <title>Kit</title>
  <script id="1" type="text/markdown">
    # Kit notebook

    A paragraph with \${n} in it.

        an indented code block
  </script>
  <script id="2" type="module" pinned>
    const n = 3;
  </script>
  <script id="3" type="module" hidden>
    const m = n + 1;
  </script>
</notebook>`;
    const notebooks = new MemFilesApi({ initialFiles: { "/kit.html": html } });
    const models = await buildPageModels({ notebooks, moduleServer, dom, siteTitle: "S" });
    expect(models.failures).toEqual([]);
    const page = models.pages[0];
    if (!page) throw new Error("no page");
    expect(page.title).toBe("Kit");
    const prose0 = (page.blocks[0] as { html: string }).html;
    expect(prose0).toContain('<h1 id="kit-notebook">Kit notebook</h1>');
    expect(prose0).toContain('A paragraph with <span id="cell-1" class="expr"></span> in it.');
    expect(prose0).toContain("<pre><code>an indented code block\n</code></pre>");
    expect(page.blocks[1]).toEqual({ kind: "cell", id: 2, source: "const n = 3;", mode: "js" });
    expect(page.blocks[2]).toEqual({ kind: "cell", id: 3, hidden: true });
  });
});
