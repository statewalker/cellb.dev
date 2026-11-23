// PROTOTYPE (statewalker/statewalker-root#236). Turns a parsed page into index.html plus one bundled module.
// ts/jsx/tsx cells go through esbuild first (types erased, JSX to react/jsx-runtime calls), then through
// notebook-kit's transpileJavaScript, and run on notebook-kit's runtime. A cell whose value is a React
// element is mounted with createRoot into a node, which the runtime then displays.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { transpileJavaScript } from "@observablehq/notebook-kit";
import * as esbuild from "esbuild";
import MarkdownIt from "markdown-it";
import ts from "typescript";
import type { Block, Cell } from "./parse.ts";

const md = new MarkdownIt({ html: true });

function isExpression(source: string): boolean {
  if (/^\s*\{/.test(source)) return false;
  const file = ts.createSourceFile("cell.tsx", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  return file.statements.length === 1 && ts.isExpressionStatement(file.statements[0]);
}

async function toJavaScript(cell: Cell): Promise<string> {
  let source = cell.source;
  // An expression cell displays its value; React elements become DOM nodes first.
  if (isExpression(source)) source = `display(__toNode((\n${source.replace(/;\s*$/, "")}\n)))`;
  if (cell.mode === "js") return source;
  const { code } = await esbuild.transform(source, {
    loader: cell.mode, jsx: "automatic", jsxImportSource: "react", format: "esm", target: "es2022",
  });
  return code;
}

// `${…}` in prose becomes a span filled by an expression cell (no nesting, no strings with braces).
function splitInline(text: string, nextId: () => number): { html: string; cells: { id: number; source: string }[] } {
  const cells: { id: number; source: string }[] = [];
  const withSpans = text.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    const id = nextId();
    cells.push({ id, source: `display(${expr})` });
    return `<span class="inline-cell" id="cell-${id}"></span>`;
  });
  return { html: md.render(withSpans), cells };
}

// notebook-kit's stdlib statically imports libraries from esm.sh (DuckDB, Vega, KaTeX, ...). A page that
// uses none of them must still load, so each such import resolves to a local stub whose exports throw
// on use. (cellb.dev's notebooks package maps them to local copies instead.)
const esmShStubs: esbuild.Plugin = {
  name: "esm-sh-stubs",
  setup(build) {
    build.onResolve({ filter: /^https:\/\/esm\.sh\// }, (args) =>
      args.kind === "import-statement" ? { path: args.path, namespace: "esm-stub" } : { path: args.path, external: true });
    build.onLoad({ filter: /.*/, namespace: "esm-stub" }, (args) => ({
      contents: `const missing = () => { throw new Error(${JSON.stringify(`PROTOTYPE: ${args.path} is not bundled`)}); };
export default new Proxy({}, { get: missing });
export const instance = missing, Icon = missing;`,
      loader: "js",
    }));
  },
};

export async function emitPage(pagePath: string, blocks: Block[], outDir: string, title: string): Promise<void> {
  let lastId = Math.max(0, ...blocks.map((b) => (b.kind === "cell" ? b.cell.id : 0)));
  const nextId = () => ++lastId;
  const defs: string[] = [];
  let body = "";
  for (const block of blocks) {
    if (block.kind === "prose") {
      const { html, cells } = splitInline(block.text, nextId);
      body += html;
      for (const c of cells) defs.push(define(c.id, transpileJavaScript(c.source)));
    } else {
      const { cell } = block;
      body += `<div class="cell" data-mode="${cell.mode}" data-line="${cell.line}" id="cell-${cell.id}"></div>\n`;
      defs.push(define(cell.id, transpileJavaScript(await toJavaScript(cell))));
    }
  }
  const entry = `import { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { createRoot } from "react-dom/client";
import { isValidElement } from "react";
const __toNode = (value) => {
  if (!isValidElement(value)) return value;
  const node = document.createElement("div");
  node.className = "react-cell";
  createRoot(node).render(value);
  return node;
};
const notebook = new NotebookRuntime({ __toNode: () => __toNode });
const state = (id) => ({ root: document.getElementById("cell-" + id), expanded: [], variables: [] });
${defs.join("\n")}
`;
  await mkdir(outDir, { recursive: true });
  await esbuild.build({
    stdin: { contents: entry, resolveDir: dirname(pagePath), sourcefile: "notebook-entry.js", loader: "js" },
    bundle: true, format: "esm", target: "es2022", outfile: join(outDir, "page.js"),
    jsx: "automatic", jsxImportSource: "react", logLevel: "silent",
    nodePaths: [join(import.meta.dirname, "..", "node_modules")],
    loader: { ".css": "css" },
    plugins: [esmShStubs],
  });
  await writeFile(join(outDir, "index.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><link rel="stylesheet" href="./page.css">
<style>.inline-cell, .inline-cell * { display: inline; margin: 0; }</style></head>
<body><main class="notebook">
${body}</main><script type="module" src="./page.js"></script></body></html>
`);
}

function define(id: number, t: ReturnType<typeof transpileJavaScript>): string {
  const { body, inputs, outputs, output, autodisplay, autoview, automutable } = t;
  return `notebook.define(state(${id}), { id: ${id}, body: ${body}, inputs: ${JSON.stringify(inputs ?? [])}, outputs: ${JSON.stringify(outputs ?? [])}, output: ${JSON.stringify(output)}, autodisplay: ${!!autodisplay}, autoview: ${!!autoview}, automutable: ${!!automutable} });`;
}
