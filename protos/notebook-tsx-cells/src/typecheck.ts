// PROTOTYPE (statewalker/statewalker-root#236). Type-checks a page's cells as one generated module
// beside the page (so its imports resolve as the page's would) and maps errors back to Markdown lines.
import { dirname, join } from "node:path";
import ts from "typescript";
import type { Cell } from "./parse.ts";

export type BuildError = { file: string; line: number; column: number; message: string; cell?: number };

// The notebook's globals that cells may use without importing them.
const PRELUDE = `declare function display<T>(value: T): T;
declare function view<T>(value: T): T;
declare const width: number;
declare const invalidation: Promise<void>;
`;

export function typecheckCells(pagePath: string, cells: Cell[]): BuildError[] {
  const virtualPath = join(dirname(pagePath), "__cells__.tsx");
  let text = PRELUDE;
  const map: { start: number; cell: Cell }[] = []; // start: 0-based line in the generated module
  for (const cell of cells) {
    map.push({ start: text.split("\n").length - 1, cell });
    text += `${cell.source}\n;\n`;
  }
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX, jsxImportSource: "react", strict: true, noImplicitAny: false,
    noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, lang, ...rest) =>
    name === virtualPath ? ts.createSourceFile(name, text, lang) : getSourceFile.call(host, name, lang, ...rest);
  const fileExists = host.fileExists;
  host.fileExists = (name) => name === virtualPath || fileExists.call(host, name);
  const program = ts.createProgram([virtualPath], options, host);
  const errors: BuildError[] = [];
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (!d.file || d.file.fileName !== virtualPath || d.start === undefined) {
      errors.push({ file: d.file?.fileName ?? pagePath, line: 0, column: 0, message });
      continue;
    }
    const pos = d.file.getLineAndCharacterOfPosition(d.start);
    const entry = [...map].reverse().find((m) => m.start <= pos.line);
    if (!entry) continue; // an error in the prelude
    errors.push({ file: pagePath, line: entry.cell.line + pos.line - entry.start, column: pos.character + 1, message, cell: entry.cell.id });
  }
  return errors;
}
