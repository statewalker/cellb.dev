/**
 * wrangler's module `rules` for the esbuild bundles of a project's `main` (Node and `cellb build`):
 * `CompiledWasm` (default export a `WebAssembly.Module`), `Data` (an `ArrayBuffer`) and `Text` (a
 * string), matched on the import specifier by `globs`, as wrangler bundles. The bytes are inlined,
 * so a bundle stays one self-contained module (a browser loads it by URL).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "esbuild";
import { moduleText } from "../bindings/worker-loader.js";

/** A wrangler `rules` entry. */
export interface ModuleRule {
  type: "ESModule" | "CommonJS" | "CompiledWasm" | "Data" | "Text" | (string & {});
  globs: string[];
  /** Keep the default rules (and later rules) of the same type. */
  fallthrough?: boolean;
}

/** wrangler's (and workerd's) defaults, applied after a project's own rules. */
export const DEFAULT_MODULE_RULES: ModuleRule[] = [
  { type: "Text", globs: ["**/*.txt", "**/*.html", "**/*.sql"] },
  { type: "Data", globs: ["**/*.bin"] },
  { type: "CompiledWasm", globs: ["**/*.wasm", "**/*.wasm?module"] },
];

const TYPES = new Set(["CompiledWasm", "Data", "Text"]);

/**
 * A glob as an esbuild filter (Go regexp) on the import specifier, as wrangler matches it: a `**`
 * segment spans any folders, `*` stays within one, anything else is literal.
 */
export function globFilter(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (glob.startsWith("**/", i)) {
      re += "(?:[^/]*/)*";
      i += 2;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** The rules in effect: the project's, then the defaults of each type no rule closed (fallthrough). */
export function effectiveRules(rules: ModuleRule[] = []): ModuleRule[] {
  const closed = new Set(rules.filter((r) => !r.fallthrough).map((r) => r.type));
  return [...rules, ...DEFAULT_MODULE_RULES.filter((r) => !closed.has(r.type))];
}

/** The module a matched file becomes. */
function ruleModule(type: string, bytes: Uint8Array): string {
  if (type === "CompiledWasm") return moduleText({ wasm: new Uint8Array(bytes) });
  if (type === "Text") return moduleText({ text: new TextDecoder().decode(bytes) });
  return `export default Uint8Array.from(atob("${Buffer.from(bytes).toString("base64")}"), (c) => c.charCodeAt(0)).buffer;`;
}

/** The esbuild plugin applying `rules` (with the defaults) to a bundle's imports. */
export function moduleRulesPlugin(rules?: ModuleRule[]): Plugin {
  return {
    name: "cellb-module-rules",
    setup(b) {
      for (const rule of effectiveRules(rules)) {
        if (!TYPES.has(rule.type)) continue;
        for (const glob of rule.globs)
          b.onResolve({ filter: globFilter(glob) }, async (a) => {
            // files on disk only: in-memory modules (Worker Loader code) bring `{ wasm }` entries
            if (a.namespace !== "file" || a.pluginData?.cellbModuleRule) return undefined;
            const spec = a.path.replace(/\?module$/, "");
            const pluginData = { type: rule.type };
            if (/^\.{0,2}\//.test(spec))
              return {
                path: resolve(a.resolveDir, spec),
                namespace: "cellb-module-rule",
                pluginData,
              };
            // a package's file: esbuild resolves it, the rule loads it
            const r = await b.resolve(spec, {
              kind: a.kind,
              importer: a.importer,
              resolveDir: a.resolveDir,
              pluginData: { cellbModuleRule: true },
            });
            if (r.errors.length) return { errors: r.errors };
            return { path: r.path, namespace: "cellb-module-rule", pluginData };
          });
      }
      b.onLoad({ filter: /.*/, namespace: "cellb-module-rule" }, (a) => ({
        contents: ruleModule(a.pluginData.type, readFileSync(a.path)),
        loader: "js",
      }));
    },
  };
}
