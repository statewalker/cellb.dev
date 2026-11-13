/**
 * A Worker Loader `{ cjs }` module as an ES module, run as workerd runs CommonJS: not in strict
 * mode unless it says so, `this` is `module.exports`, and importing it gives `module.exports` as
 * the default export.
 *
 * An ES module's own code is always strict, so the CommonJS code runs through `Function`. Code
 * there is invisible to the bundler (esbuild on Node, the Blob-URL loader in a browser), and its
 * `import()` would resolve against the wrong module. So the code is parsed first (acorn), and each
 * `import("x")` and `require("x")` with a literal specifier is listed in the ES module itself,
 * where the bundler sees it: `import()` calls go to `__cellbImport`, which runs the listed
 * `import("x")`, and `require("x")` returns the listed static import (a CommonJS module's
 * `module.exports`, an ES module's namespace). Other specifiers fall back to `import()` and the
 * realm's own `require`.
 */
import { type Node, parse } from "acorn";

/** Marks the namespace of a module made here: `require()` of it gives its `module.exports`. */
const CJS_MARK = "__cellbCommonJs";

interface Scan {
  /** Literal specifiers of `import()` calls, and where each call's `import` keyword starts. */
  imports: { spec?: string; at: number }[];
  /** Literal specifiers of `require()` calls. */
  requires: Set<string>;
}

function scan(source: string): Scan | undefined {
  let ast: Node;
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowHashBang: true,
    });
  } catch {
    return undefined; // `Function` reports the syntax error when the module is evaluated
  }
  const found: Scan = { imports: [], requires: new Set() };
  const literal = (n: any) =>
    n?.type === "Literal" && typeof n.value === "string" ? (n.value as string) : undefined;
  const visit = (n: any) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "ImportExpression") found.imports.push({ spec: literal(n.source), at: n.start });
    if (
      n.type === "CallExpression" &&
      n.callee?.type === "Identifier" &&
      n.callee.name === "require" &&
      n.arguments.length === 1
    ) {
      const spec = literal(n.arguments[0]);
      if (spec !== undefined) found.requires.add(spec);
    }
    for (const key of Object.keys(n)) {
      const v = n[key];
      if (Array.isArray(v)) for (const c of v) visit(c);
      else if (v && typeof v === "object" && typeof v.type === "string") visit(v);
    }
  };
  visit(ast);
  return found;
}

export function commonJsModule(source: string, name: string): string {
  const found = scan(source) ?? { imports: [], requires: new Set<string>() };
  // Each `import(…)` keyword becomes `__cellbImport` (same length: positions stay valid).
  let body = source;
  for (const { at } of [...found.imports].sort((a, b) => b.at - a.at))
    body = `${body.slice(0, at)}__cellbImport${body.slice(at + "import".length)}`;
  const q = JSON.stringify;
  const requires = [...found.requires];
  const imports = [...new Set(found.imports.map((i) => i.spec).filter((s) => s !== undefined))];
  const lines = [
    ...requires.map((spec, i) => `import * as __cellbDep${i} from ${q(spec)};`),
    `const __cellbRequired = { ${requires.map((spec, i) => `${q(spec)}: __cellbDep${i}`).join(", ")} };`,
    `const __cellbImported = { ${imports.map((spec) => `${q(spec)}: () => import(${q(spec)})`).join(", ")} };`,
    "const __cellbImport = (spec) => (__cellbImported[spec] ?? (() => import(spec)))();",
    "const __cellbRequire = (spec) => {",
    "  const ns = __cellbRequired[spec];",
    `  if (ns) return ns.${CJS_MARK} ? ns.default : ns;`,
    '  if (typeof require === "function") return require(spec);',
    "  throw new Error(`Cannot find module '${spec}'`);",
    "};",
    "const module = { exports: {} };",
    `new Function("module", "exports", "require", "__filename", "__dirname", "__cellbImport", ${q(`${body}\n//# sourceURL=${name.replace(/\s/g, "%20")}`)})`,
    `  .call(module.exports, module, module.exports, __cellbRequire, ${q(name)}, "/", __cellbImport);`,
    `export const ${CJS_MARK} = true;`,
    "export default module.exports;",
  ];
  return lines.join("\n");
}
