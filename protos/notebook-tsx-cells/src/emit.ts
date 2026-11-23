// PROTOTYPE (statewalker/statewalker-root#236). Turns a parsed page into index.html plus one bundled module.
// ts/jsx/tsx cells go through esbuild first (types erased, JSX to react/jsx-runtime calls), then through
// notebook-kit's transpileJavaScript, and run on notebook-kit's runtime. A cell whose value is a React
// element is mounted with createRoot into a node, which the runtime then displays.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { bundle, nodeModulesPackages } from "@statewalker/webrun-bundler";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { transpileJavaScript } from "@observablehq/notebook-kit";
import * as esbuild from "esbuild";
import MarkdownIt from "markdown-it";
import ts from "typescript";
import type { LocalBuiltinsServer } from "../../../packages/notebooks/src/builtins.ts";
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

const RUNTIME = "@observablehq/notebook-kit/runtime";
const PROTO_DIR = join(import.meta.dirname, "..");

export async function emitPage(pagePath: string, blocks: Block[], outDir: string, title: string, modules: LocalBuiltinsServer): Promise<{ runtimeUrl: string; stylesUrl: string; used: Set<string> }> {
  let lastId = Math.max(0, ...blocks.map((b) => (b.kind === "cell" ? b.cell.id : 0)));
  const nextId = () => ++lastId;
  const defs: string[] = [];
  const used = new Set<string>();
  const track = (t: ReturnType<typeof transpileJavaScript>) => { for (const i of t.inputs ?? []) used.add(i); return t; };
  let body = "";
  for (const block of blocks) {
    if (block.kind === "prose") {
      const { html, cells } = splitInline(block.text, nextId);
      body += html;
      for (const c of cells) defs.push(define(c.id, track(transpileJavaScript(c.source))));
    } else {
      const { cell } = block;
      body += `<div class="cell" data-mode="${cell.mode}" data-line="${cell.line}" id="cell-${cell.id}"></div>\n`;
      defs.push(define(cell.id, track(transpileJavaScript(await toJavaScript(cell)))));
    }
  }
  const entry = `import { NotebookRuntime, library } from "${RUNTIME}";
import { createRoot } from "react-dom/client";
import { isValidElement } from "react";
const __toNode = (value) => {
  if (!isValidElement(value)) return value;
  const node = document.createElement("div");
  node.className = "react-cell";
  createRoot(node).render(value);
  return node;
};
const notebook = new NotebookRuntime({ ...library, __toNode: () => __toNode });
const state = (id) => ({ root: document.getElementById("cell-" + id), expanded: [], variables: [] });
${defs.join("\n")}
`;
  await mkdir(outDir, { recursive: true });
  // notebook-kit's runtime is not bundled: the page loads it from the module server, so its standard
  // library stays lazy and its esm.sh imports go through withLocalBuiltins. webrun-bundler bundles
  // the rest (the cells, React, the page's own modules, its packages) through a FilesApi, with
  // source maps back to the original files.
  const runtimeUrl = (await modules.resolve({ pkg: "@observablehq/notebook-kit", version: "2.11.0", subpath: "runtime" })).url;
  const stylesUrl = runtimeUrl.replace(/runtime\/index\.js$/, "styles/index.css");
  const pageDir = dirname(pagePath);
  const entryName = `__${basename(pagePath, ".md")}.entry.js`;
  await writeFile(join(pageDir, entryName), entry);
  try {
    const result = await bundle({
      // The FilesApi is the prototype's folder, so the page's imports and node_modules both resolve.
      esbuild, files: new NodeFilesApi({ rootDir: PROTO_DIR }),
      entry: `/${relative(PROTO_DIR, join(pageDir, entryName))}`, packages: nodeModulesPackages(),
      external: [RUNTIME], conditions: ["source", "browser"], minify: true, outfile: "page.js",
      define: { "process.env.NODE_ENV": '"production"' },
      esbuildOptions: { jsx: "automatic", jsxImportSource: "react", loader: { ".css": "css" } },
    });
    await writeFile(join(outDir, "page.js"), result.code);
    await writeFile(join(outDir, "page.js.map"), JSON.stringify(result.map));
  } finally {
    await rm(join(pageDir, entryName), { force: true });
  }
  await writeFile(join(outDir, "index.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<script type="importmap">${JSON.stringify({ imports: { [RUNTIME]: runtimeUrl } })}</script>
<link rel="stylesheet" href="${stylesUrl}">
<style>.inline-cell, .inline-cell * { display: inline; margin: 0; }</style></head>
<body><main class="notebook">
${body}</main><script type="module" src="./page.js"></script></body></html>
`);
  return { runtimeUrl, stylesUrl, used };
}

function define(id: number, t: ReturnType<typeof transpileJavaScript>): string {
  const { body, inputs, outputs, output, autodisplay, autoview, automutable } = t;
  return `notebook.define(state(${id}), { id: ${id}, body: ${body}, inputs: ${JSON.stringify(inputs ?? [])}, outputs: ${JSON.stringify(outputs ?? [])}, output: ${JSON.stringify(output)}, autodisplay: ${!!autodisplay}, autoview: ${!!autoview}, automutable: ${!!automutable} });`;
}
