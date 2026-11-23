// PROTOTYPE (statewalker/statewalker-root#236). Type checking is a plug-in: the build hands each
// checker the page's cells and reports what it returns.
import ts from "typescript";
import type { Cell } from "./parse.ts";
import { type BuildError, checkModule, GeneratedModule } from "./typecheck.ts";

export type TypeChecker = { name: string; check(page: { path: string; cells: Cell[] }): BuildError[] };

export const noTypeCheck: TypeChecker = { name: "none", check: () => [] };

// The notebook's globals. A Mutable is branded so a plain { value } object is not mistaken for one.
const PRELUDE = `declare const __mutable: unique symbol;
interface Mutable<T> { value: T; readonly [__mutable]: true }
declare function Mutable<T>(value: T): Mutable<T>;
declare function display<T>(value: T): T;
declare function view<T extends { value: unknown }>(element: T): AsyncGenerator<T["value"]>;
declare const width: number;
declare const invalidation: Promise<void>;
declare const html: (strings: TemplateStringsArray, ...values: unknown[]) => HTMLElement;
declare const svg: (strings: TemplateStringsArray, ...values: unknown[]) => SVGElement;
// notebook-kit's other recommended libraries, untyped here (the kit would take their packages' types).
declare const _: any, aq: any, Arrow: any, d3: any, dot: any, duckdb: any, echarts: any, Inputs: any,
  L: any, mermaid: any, Plot: any, tex: any, topojson: any, vl: any;
/** What other cells see of a cell's output: a Mutable's value, a generator's yield, a promise's result. */
type __Value<T> = T extends Mutable<infer V> ? V : T extends AsyncGenerator<infer V, any, any> ? V
  : T extends Generator<infer V, any, any> ? V : Awaited<T>;
`;

/** Every cell in page order, in one module: simple, but blind to Observable's reactivity. */
export const pageOrderChecker: TypeChecker = {
  name: "page-order",
  check({ path, cells }) {
    const m = new GeneratedModule();
    m.add(PRELUDE);
    for (const cell of cells) {
      m.addSource(cell, cell.line, cell.source);
      m.add(";");
    }
    return checkModule(path, m);
  },
};

type Analysis = { cell: Cell; file: ts.SourceFile; expression: boolean; imports: ts.ImportDeclaration[]; outputs: string[]; refs: Set<string> };

function bindingNames(name: ts.BindingName, into: string[]) {
  if (ts.isIdentifier(name)) into.push(name.text);
  else for (const e of name.elements) if (!ts.isOmittedExpression(e)) bindingNames(e.name, into);
}

function analyse(cell: Cell): Analysis {
  const file = ts.createSourceFile("cell.tsx", cell.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports: ts.ImportDeclaration[] = [];
  const outputs: string[] = [];
  for (const s of file.statements) {
    if (ts.isImportDeclaration(s)) imports.push(s);
    else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) bindingNames(d.name, outputs);
    else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) outputs.push(s.name.text);
  }
  const refs = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)
      && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) refs.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(file);
  const expression = !/^\s*\{/.test(cell.source) && file.statements.length === 1 && ts.isExpressionStatement(file.statements[0]);
  return { cell, file, expression, imports, outputs, refs };
}

/**
 * Observable's semantics: a cell may use a name defined anywhere on the page, and sees another cell's
 * output as a value (a Mutable's value, a generator's latest yield, a promise's result). Each cell
 * becomes a function whose parameters are its inputs, typed as those values from the defining cell's
 * outputs; cells are written in dependency order; imports are hoisted. Source lines keep their mapping.
 */
export const reactiveChecker: TypeChecker = {
  name: "reactive",
  check({ path, cells }) {
    const all = cells.map(analyse);
    const owner = new Map<string, Analysis>();
    for (const a of all) for (const o of a.outputs) owner.set(o, a);
    const inputs = new Map(all.map((a) => [a, [...a.refs].filter((r) => owner.has(r) && owner.get(r) !== a && !a.outputs.includes(r))]));
    const ordered: Analysis[] = [];
    const seen = new Set<Analysis>();
    const place = (a: Analysis) => {
      if (seen.has(a)) return;
      seen.add(a);
      for (const i of inputs.get(a)!) place(owner.get(i)!);
      ordered.push(a);
    };
    all.forEach(place);

    const m = new GeneratedModule();
    m.add(PRELUDE);
    for (const a of all) for (const imp of a.imports) {
      const line = a.file.getLineAndCharacterOfPosition(imp.getStart()).line;
      m.addSource(a.cell, a.cell.line + line, imp.getText());
    }
    for (const a of ordered) {
      const id = a.cell.id;
      const params = inputs.get(a)!.map((i) => `${i}: __Value<__Out_${owner.get(i)!.cell.id}[${JSON.stringify(i)}]>`);
      m.add(`async function __cell_${id}({ ${inputs.get(a)!.join(", ")} }: { ${params.join("; ")} }) {`, a.cell);
      let body = a.cell.source.split("\n");
      for (const imp of a.imports) { // blank the hoisted imports, keeping every other line where it was
        const from = a.file.getLineAndCharacterOfPosition(imp.getStart()).line;
        const to = a.file.getLineAndCharacterOfPosition(imp.getEnd()).line;
        for (let l = from; l <= to; l++) body[l] = "";
      }
      if (a.expression) {
        m.add("return (", a.cell);
        m.addSource(a.cell, a.cell.line, body.join("\n").replace(/;\s*$/, ""));
        m.add(");", a.cell);
      } else {
        m.addSource(a.cell, a.cell.line, body.join("\n"));
        m.add(`;\nreturn { ${a.outputs.join(", ")} };`, a.cell);
      }
      m.add(`}\ntype __Out_${id} = Awaited<ReturnType<typeof __cell_${id}>>;`, a.cell);
    }
    return checkModule(path, m);
  },
};
