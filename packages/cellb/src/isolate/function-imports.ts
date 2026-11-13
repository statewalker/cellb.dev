/**
 * `import()` in code a loaded Worker builds at run time with `Function` (or `AsyncFunction` and the
 * generator constructors): Kitesurf imports page modules through
 * `new (async () => {}).constructor("spec", "return await import(spec)")`. On workerd that resolves
 * against the loaded Worker's modules. In a browser isolate it would resolve against the isolate
 * worker's own URL, and no bundler or module hook sees such code.
 *
 * The isolate's realm is the loaded Worker's, so its function constructors are wrapped: a body
 * that contains `import(` is parsed, and each `import(` becomes a call of
 * `globalThis.__cellbFunctionImport`, which the loader binds to the loaded Worker's module
 * resolution (browser-modules.ts). Bodies without `import`, and bodies that do not parse (the
 * constructor reports their syntax error), are left as they are.
 */
import { parse } from "acorn";

/** The global that rewritten bodies call: `(spec) => Promise<namespace>`. */
export const FUNCTION_IMPORT = "__cellbFunctionImport";

const kinds: [Function, string][] = [
  [Function, "function"],
  [(async () => {}).constructor, "async function"],
  [function* () {}.constructor, "function*"],
  [async function* () {}.constructor, "async function*"],
];

/** A body's `import(` calls made into `__cellbFunctionImport(` calls, or the body unchanged. */
export function routeBodyImports(params: string[], body: string, kind: string): string {
  if (!body.includes("import")) return body;
  // The constructor's own wrapping (ECMA-262 CreateDynamicFunction), so positions match the body.
  const head = `(${kind} anonymous(${params.join(",")}\n) {\n`;
  let ast: any;
  try {
    ast = parse(`${head}${body}\n})`, { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    return body;
  }
  const starts: number[] = [];
  const visit = (n: any) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "ImportExpression") starts.push(n.start - head.length);
    for (const key of Object.keys(n)) {
      const v = n[key];
      if (Array.isArray(v)) for (const c of v) visit(c);
      else if (v && typeof v === "object" && typeof v.type === "string") visit(v);
    }
  };
  visit(ast);
  let out = body;
  for (const at of starts.sort((a, b) => b - a))
    if (at >= 0) out = `${out.slice(0, at)}${FUNCTION_IMPORT}${out.slice(at + "import".length)}`;
  return out;
}

let installed = false;

/**
 * Wraps this realm's function constructors (`Function`, and the constructors reached through
 * `.constructor` of async and generator functions) so that bodies built at run time route their
 * `import()` through `globalThis.__cellbFunctionImport`. Once per realm.
 */
export function routeFunctionImports(): void {
  if (installed) return;
  installed = true;
  const rewrite = (args: unknown[], kind: string) => {
    if (!args.length) return args;
    const params = args.slice(0, -1).map(String);
    return [...params, routeBodyImports(params, String(args[args.length - 1]), kind)];
  };
  for (const [Ctor, kind] of kinds) {
    const wrapped: Function = new Proxy(Ctor, {
      apply: (target, thisArg, args) => Reflect.apply(target, thisArg, rewrite(args, kind)),
      construct: (target, args, newTarget) =>
        Reflect.construct(target, rewrite(args, kind), newTarget === wrapped ? target : newTarget),
    });
    // `fn.constructor` (how code reaches AsyncFunction) and, for Function, the global itself.
    Object.defineProperty(Ctor.prototype, "constructor", {
      value: wrapped,
      writable: true,
      configurable: true,
    });
    if (Ctor === Function)
      Object.defineProperty(globalThis, "Function", {
        value: wrapped,
        writable: true,
        configurable: true,
      });
  }
}
