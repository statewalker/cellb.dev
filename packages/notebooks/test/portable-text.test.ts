// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these tests feed `${…}` expressions to the notebook parser as plain strings
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { parse } from "acorn";
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
      { kind: "cell", id: 2, source: "const answer = 6 * 7;", mode: "js", line: 9 },
      {
        kind: "cell",
        id: 3,
        source: 'fetch("https://example.com") // shown, not run',
        mode: "js",
        run: false,
        line: 13,
      },
      { kind: "cell", id: 4, line: 19 },
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
        'import {define, observe} from "/m/@observablehq/notebook-kit@1.0.0/runtime.js";',
      ),
    ).toBe(true);
    expect(page.content.some((b) => b._type === "code-cell")).toBe(true);
    expect(models.inputs).toContain("answer");
  });

  it("maps the page script back to the Markdown: an inline source map and a sourceURL", async () => {
    const notebooks = new MemFilesApi({ initialFiles: { "/features.md": NOTEBOOK } });
    const models = await buildPageModels({
      notebooks,
      moduleServer,
      dom,
      siteTitle: "S",
      base: "/t",
    });
    const page = models.pages[0];
    if (!page) throw new Error("no page");
    // The whole script is valid module JavaScript (helpers included).
    expect(() => parse(page.script, { ecmaVersion: "latest", sourceType: "module" })).not.toThrow();
    const lines = page.script.split("\n");
    expect(lines.at(-2)).toBe("//# sourceURL=/t/features.page.js");
    const prefix = "//# sourceMappingURL=data:application/json;base64,";
    expect(lines.at(-1)?.startsWith(prefix)).toBe(true);
    const map = JSON.parse(
      Buffer.from((lines.at(-1) ?? "").slice(prefix.length), "base64").toString(),
    );
    expect(map.sources).toEqual(["/features.md"]);
    expect(map.sourcesContent).toEqual([NOTEBOOK]);
    // A token's generated position, found by searching the script, maps to the Markdown.
    const where = (needle: string, from = 0) => {
      // A needle starting with a newline points at the character after it.
      const offset = page.script.indexOf(needle, from) + (needle.startsWith("\n") ? 1 : 0);
      const before = page.script.slice(0, offset).split("\n");
      return { line: before.length, column: (before.at(-1) ?? "").length };
    };
    const trace = new TraceMap(map);
    // `6 * 7` in cell 2: line 9 of NOTEBOOK, column 15 (0-based) in "const answer = 6 * 7;".
    expect(originalPositionFor(trace, where("6 * 7"))).toMatchObject({
      source: "/features.md",
      line: 9,
      column: 15,
    });
    // The expression cell 1 is `answer`, on a line of its own in its body (`(answer) => {` before
    // it is generated): line 6, column 34 (0-based) in its prose.
    const exprBody = page.script.indexOf('"id":1,"body":');
    expect(originalPositionFor(trace, where("\nanswer\n", exprBody + 1))).toMatchObject({
      source: "/features.md",
      line: 6,
      column: 34,
    });
  });

  it("locates a stack frame of the page script in the Markdown, as the error display does", async () => {
    const notebooks = new MemFilesApi({ initialFiles: { "/features.md": NOTEBOOK } });
    const models = await buildPageModels({
      notebooks,
      moduleServer,
      dom,
      siteTitle: "S",
      base: "/t",
    });
    const page = models.pages[0];
    if (!page) throw new Error("no page");
    // The helpers sit between the last define() and the sourceURL comment.
    const helpers = page.script.slice(
      page.script.indexOf("const __positions"),
      page.script.indexOf("//# sourceURL="),
    );
    const locate = new Function("observe", `${helpers}\nreturn __locate;`)(() => ({})) as (
      e: unknown,
    ) => string | undefined;
    // `6 * 7` is on line 8 of the script; a frame at its `6` (1-based column 16) is features.md
    // line 9, column 16 ("const answer = 6 * 7;").
    const frame = (line: number, column: number) => ({
      stack: `Error: x\n    at <anonymous> (http://example.com/t/features.page.js:${line}:${column})`,
    });
    const line = page.script.split("\n").findIndex((l) => l.includes("6 * 7")) + 1;
    expect(locate(frame(line, 16))).toBe("features.md:9:16");
    // A frame elsewhere (a package, or an unmapped helper line) is not located.
    expect(locate({ stack: "Error: x\n    at f (http://example.com/m/x.js:1:1)" })).toBeUndefined();
    expect(locate(frame(1, 1))).toBeUndefined();
  });

  it("records where each cell and expression starts in the Markdown file", async () => {
    const notebooks = new MemFilesApi({ initialFiles: { "/features.md": NOTEBOOK } });
    const models = await buildPageModels({ notebooks, moduleServer, dom, siteTitle: "S" });
    const page = models.pages[0];
    if (!page) throw new Error("no page");
    expect(page.notebook).toBe("/features.md");
    // Lines count from the file's first line, front matter included (NOTEBOOK's lines 1-3).
    expect(page.positions).toMatchObject({
      1: { line: 6, column: 35 }, // `answer` inside "… the answer is ${answer}."
      2: { line: 9, column: 1 }, // `const answer = 6 * 7;`
      3: { line: 13, column: 1 }, // the run=false cell
      4: { line: 19, column: 1 }, // `SELECT 1`
    });
    const cells = page.blocks.filter((b) => b.kind === "cell");
    expect(cells.map((b) => (b as { line?: number }).line)).toEqual([9, 13, 19]);
  });

  it("runs jsx and tsx cells: compiled, with React pinned through the module server", async () => {
    const notebooks = new MemFilesApi({
      initialFiles: {
        "/react.md": [
          "# React",
          "",
          "```tsx echo",
          'const Door = ({ open }: { open: boolean }) => <b>{open ? "open" : "closed"}</b>;',
          "```",
          "",
          "```jsx",
          "<Door open={true} />",
          "```",
          "",
        ].join("\n"),
      },
    });
    const models = await buildPageModels({ notebooks, moduleServer, dom, siteTitle: "S" });
    expect(models.failures).toEqual([]);
    const page = models.pages[0];
    if (!page) throw new Error("no page");
    // Code cells, not prose: the tsx cell shows its source (echo), both run.
    expect(page.blocks.filter((b) => b.kind === "cell")).toEqual([
      { kind: "cell", id: 1, source: expect.stringContaining("const Door"), mode: "tsx", line: 4 },
      { kind: "cell", id: 2, line: 8 },
    ]);
    const ids = [...page.script.matchAll(/getElementById\("cell-(\d+)"\)/g)].map((m) => m[1]);
    expect(ids.sort()).toEqual(["1", "2"]);
    // JSX compiled away; the runtime and React come from the module server's pins.
    expect(page.script).not.toContain("<b>");
    expect(page.script).toContain("/m/react@1.0.0/jsx-runtime.js");
    // Pinned for the static export too (its module closure starts from the pins).
    expect(models.pins).toMatchObject({
      "react/jsx-runtime": "/m/react@1.0.0/jsx-runtime.js",
      "react-dom/client": "/m/react-dom@1.0.0/client.js",
    });
    expect(models.inputs).toContain("Door");
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
    expect(page.blocks[1]).toEqual({
      kind: "cell",
      id: 2,
      source: "const n = 3;",
      mode: "js",
      line: 12,
    });
    expect(page.blocks[2]).toEqual({ kind: "cell", id: 3, hidden: true, line: 15 });
    // A Notebook Kit cell's text is dedented: its column is where the text starts in the file.
    expect(page.notebook).toBe("/kit.html");
    expect(page.positions).toEqual({
      1: { line: 7, column: 24 }, // `n` in "A paragraph with ${n} in it."
      2: { line: 12, column: 5 },
      3: { line: 15, column: 5 },
    });
  });

  it("maps Notebook Kit cells as notebook-kit dedents them: same-line text, 4-space indents, a leading blank line, quoted `>`", async () => {
    const html = [
      "<notebook>",
      '  <script id="1" type="text/markdown">First ${a}',
      "    Second ${b}",
      "      Third ${c}",
      "  Fourth ${d}",
      "  </script>",
      '  <script id="2" type="module" output="x>y">',
      "",
      "",
      "    const e = 1;",
      "  </script>",
      "</notebook>",
      "<script>analytics()</script>",
    ].join("\n");
    // Where a name really is in the file, found by searching the text: an oracle independent of
    // the parser.
    const at = (needle: string) => {
      const offset = html.indexOf(needle);
      const before = html.slice(0, offset).split("\n");
      return { line: before.length, column: (before.at(-1) ?? "").length + 1 };
    };
    const notebooks = new MemFilesApi({ initialFiles: { "/kit.html": html } });
    const models = await buildPageModels({ notebooks, moduleServer, dom, siteTitle: "S" });
    expect(models.failures).toEqual([]);
    const page = models.pages[0];
    if (!page) throw new Error("no page");
    const exprs = [at("a}"), at("b}"), at("c}"), at("d}")];
    expect([1, 2, 3, 4].map((id) => page.positions[id])).toEqual(exprs);
    // The cell's text is "\n\n\n    const e = 1;\n  ": notebook-kit drops the trailing blank line and
    // one leading one (the rest of the tag's line), so its value starts with the blank line 8.
    expect(page.positions[5]).toEqual({ line: 8, column: 1 });
  });
});
