// PROTOTYPE (statewalker/statewalker-root#236). Type-checks one generated module, placed beside the
// page (so its imports resolve as the page's would), and maps each diagnostic back to the Markdown.
import { dirname, join } from "node:path";
import ts from "typescript";
import type { Cell } from "./parse.ts";

export type BuildError = { file: string; line: number; column: number; message: string; cell?: number };

/** Lines [genStart, genStart + length) of the generated module are lines [mdStart, …) of the page. */
export type Segment = { genStart: number; length: number; mdStart: number; cell: Cell };

/** A module under construction that remembers where each piece of cell source came from. */
export class GeneratedModule {
  private lines: string[] = [];
  readonly segments: Segment[] = [];
  /** owner: the cell an error on these generated (non-source) lines is blamed on */
  private owners: { gen: number; cell: Cell }[] = [];
  add(text: string, owner?: Cell) {
    if (owner) this.owners.push({ gen: this.lines.length, cell: owner });
    this.lines.push(...text.split("\n"));
  }
  addSource(cell: Cell, mdStart: number, text: string) {
    this.segments.push({ genStart: this.lines.length, length: text.split("\n").length, mdStart, cell });
    this.lines.push(...text.split("\n"));
  }
  get text() { return this.lines.join("\n"); }
  locate(genLine: number): { line: number; cell?: Cell; exact: boolean } | undefined {
    const s = this.segments.find((s) => genLine >= s.genStart && genLine < s.genStart + s.length);
    if (s) return { line: s.mdStart + genLine - s.genStart, cell: s.cell, exact: true };
    const o = [...this.owners].reverse().find((o) => o.gen <= genLine);
    return o && { line: o.cell.line, cell: o.cell, exact: false };
  }
}

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX, jsxImportSource: "react", strict: true, noImplicitAny: false,
  noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
};

export function checkModule(pagePath: string, module: GeneratedModule): BuildError[] {
  const virtualPath = join(dirname(pagePath), "__cells__.tsx");
  const text = module.text;
  const host = ts.createCompilerHost(OPTIONS);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, lang, ...rest) =>
    name === virtualPath ? ts.createSourceFile(name, text, lang) : getSourceFile.call(host, name, lang, ...rest);
  const fileExists = host.fileExists;
  host.fileExists = (name) => name === virtualPath || fileExists.call(host, name);
  const program = ts.createProgram([virtualPath], OPTIONS, host);
  const errors: BuildError[] = [];
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (!d.file || d.file.fileName !== virtualPath || d.start === undefined) {
      errors.push({ file: d.file?.fileName ?? pagePath, line: 0, column: 0, message });
      continue;
    }
    const pos = d.file.getLineAndCharacterOfPosition(d.start);
    const where = module.locate(pos.line);
    if (!where) continue; // the prelude
    errors.push({ file: pagePath, line: where.line, column: where.exact ? pos.character + 1 : 1, message, cell: where.cell?.id });
  }
  return errors;
}
