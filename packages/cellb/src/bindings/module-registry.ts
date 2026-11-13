/**
 * `import()` in a loaded Worker resolves against its own modules, as on workerd: the specifier
 * names a module of the `WorkerCode` exactly (Kitesurf names page modules by their URL), or is
 * a path relative to the importing module. The loaders bundle (esbuild on Node) or link (Blob URLs
 * in a browser) the modules, which handles a literal relative `import("./x.js")`; a computed
 * specifier, or one that is a module's whole name, is resolved at run time instead.
 *
 * `routeDynamicImports` rewrites those `import(spec)` calls of a module to
 * `__cellbImportFrom(spec, "<module name>")`; each loader defines `__cellbImportFrom` with
 * `resolveModuleName` over its own modules, falling back to the realm's `import()`.
 */
import { parse } from "acorn";

/** The name of the loaded module `spec` names from module `importer`, or `undefined`. */
export function resolveModuleName(
  spec: string,
  importer: string,
  names: ReadonlySet<string>,
): string | undefined {
  if (names.has(spec)) return spec;
  if (!/^\.{0,2}\//.test(spec)) return undefined;
  const name = new URL(spec, `file:///${importer}`).pathname.slice(1);
  return names.has(name) ? name : undefined;
}

/** The same function as source text, for a registry module generated into a bundle. */
export const RESOLVE_MODULE_NAME_SOURCE = `(spec, importer, names) => {
  if (names.has(spec)) return spec;
  if (!/^\\.{0,2}\\//.test(spec)) return undefined;
  const name = new URL(spec, "file:///" + importer).pathname.slice(1);
  return names.has(name) ? name : undefined;
}`;

/** The identifier rewritten calls use. */
export const IMPORT_FROM = "__cellbImportFrom";

/**
 * `source` (an ES module named `name`) with each `import(spec)` that the bundler cannot link (a
 * computed specifier, or a literal that is not a relative path) calling `__cellbImportFrom(spec,
 * name)`. Returns `undefined` when there is none (or the module does not parse: the loader then
 * reports its syntax error).
 */
export function routeDynamicImports(source: string, name: string): string | undefined {
  if (!source.includes("import")) return undefined;
  let ast: any;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  } catch {
    return undefined;
  }
  const calls: { start: number; sourceEnd: number }[] = [];
  const visit = (n: any) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "ImportExpression") {
      const literal =
        n.source.type === "Literal" && typeof n.source.value === "string"
          ? (n.source.value as string)
          : undefined;
      if (literal === undefined || !/^\.{1,2}\//.test(literal))
        calls.push({ start: n.start, sourceEnd: n.source.end });
    }
    for (const key of Object.keys(n)) {
      const v = n[key];
      if (Array.isArray(v)) for (const c of v) visit(c);
      else if (v && typeof v === "object" && typeof v.type === "string") visit(v);
    }
  };
  visit(ast);
  if (!calls.length) return undefined;
  let out = source;
  // From the end, so earlier positions stay valid: `import(spec` → `__cellbImportFrom(spec, name`.
  for (const { start, sourceEnd } of calls.sort((a, b) => b.start - a.start))
    out =
      out.slice(0, start) +
      IMPORT_FROM +
      out.slice(start + "import".length, sourceEnd) +
      `, ${JSON.stringify(name)}` +
      out.slice(sourceEnd);
  return out;
}

/** `prelude` put in front of `source` on its first line (after a hashbang), so lines keep their numbers. */
export function prefixModule(source: string, prelude: string): string {
  if (!source.startsWith("#!")) return prelude + source;
  const nl = source.indexOf("\n");
  return nl < 0
    ? `${source}\n${prelude}`
    : `${source.slice(0, nl + 1)}${prelude}${source.slice(nl + 1)}`;
}

/** What an ES module exports by name, and the specifiers it re-exports everything from. */
export interface ModuleExports {
  names: string[];
  stars: string[];
}

/** The exports of ES module `source` (`undefined` if it does not parse). */
export function moduleExports(source: string): ModuleExports | undefined {
  let ast: any;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  } catch {
    return undefined;
  }
  const names = new Set<string>();
  const stars: string[] = [];
  const nameOf = (n: any) => (n.type === "Identifier" ? n.name : String(n.value));
  const bound = (p: any) => {
    if (!p) return;
    if (p.type === "Identifier") names.add(p.name);
    else if (p.type === "ObjectPattern")
      for (const q of p.properties) bound(q.type === "RestElement" ? q.argument : q.value);
    else if (p.type === "ArrayPattern") for (const q of p.elements) bound(q);
    else if (p.type === "RestElement") bound(p.argument);
    else if (p.type === "AssignmentPattern") bound(p.left);
  };
  for (const node of ast.body) {
    if (node.type === "ExportDefaultDeclaration") names.add("default");
    else if (node.type === "ExportAllDeclaration") {
      if (node.exported) names.add(nameOf(node.exported));
      else stars.push(String(node.source.value));
    } else if (node.type === "ExportNamedDeclaration") {
      const d = node.declaration;
      if (d?.type === "VariableDeclaration") for (const v of d.declarations) bound(v.id);
      else if (d?.id) names.add(d.id.name);
      for (const s of node.specifiers ?? []) names.add(nameOf(s.exported));
    }
  }
  return { names: [...names], stars };
}

/**
 * Each module's export names, `export *` followed within the modules (as far as they resolve).
 * A module that does not parse, or a star from outside them, adds nothing.
 */
export function exportNamesByModule(modules: Record<string, string>): Record<string, string[]> {
  const own = new Map<string, ModuleExports>();
  for (const [name, text] of Object.entries(modules))
    own.set(name, moduleExports(text) ?? { names: [], stars: [] });
  const names = new Set(own.keys());
  const all = (name: string, seen: Set<string>): Set<string> => {
    const out = new Set(own.get(name)?.names ?? []);
    if (seen.has(name)) return out;
    seen.add(name);
    for (const spec of own.get(name)?.stars ?? []) {
      const target = resolveModuleName(spec, name, names);
      if (target === undefined) continue;
      for (const n of all(target, seen)) if (n !== "default") out.add(n);
    }
    return out;
  };
  return Object.fromEntries([...names].map((n) => [n, [...all(n, new Set())]]));
}

/**
 * An ES module that stands for loaded module `name` where code imports it by a specifier no
 * bundler saw (an `import()` in code built with `Function`): it takes the bundled module's
 * namespace from the realm's registry (`globalThis.__cellbLoadedModules`) and re-exports it.
 */
export function loadedModuleShim(name: string, exportNames: string[]): string {
  const ident = /^[A-Za-z_$][\w$]*$/;
  const named = exportNames.filter((n) => n !== "default" && ident.test(n));
  return [
    `const ns = await globalThis.__cellbLoadedModules.load(${JSON.stringify(name)});`,
    ...(exportNames.includes("default") ? ["export default ns.default;"] : []),
    ...(named.length ? [`export const { ${named.join(", ")} } = ns;`] : []),
  ].join("\n");
}
