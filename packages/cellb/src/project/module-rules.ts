/**
 * wrangler's module `rules` for the esbuild bundles of a project's `main` (Node and `cellb build`):
 * `CompiledWasm` (default export a `WebAssembly.Module`), `Data` (an `ArrayBuffer`) and `Text` (a
 * string), matched on the import specifier by `globs`, as wrangler bundles. The bytes are inlined
 * as base64 (about 1.33 times their size), so a bundle stays one self-contained module (a browser
 * loads it by URL).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Plugin } from "esbuild";

/** A wrangler `rules` entry. */
export interface ModuleRule {
  type: "ESModule" | "CommonJS" | "CompiledWasm" | "Data" | "Text" | (string & {});
  globs: string[];
  /** `true`: later rules of the same type (the defaults among them) apply too. */
  fallthrough?: boolean;
}

/** wrangler's (and workerd's) defaults, applied after a project's own rules. */
export const DEFAULT_MODULE_RULES: ModuleRule[] = [
  { type: "Text", globs: ["**/*.txt", "**/*.html", "**/*.sql"] },
  { type: "Data", globs: ["**/*.bin"] },
  { type: "CompiledWasm", globs: ["**/*.wasm", "**/*.wasm?module"] },
];

/** The rule types the bundles apply; ESModule and CommonJS are esbuild's own business. */
const TYPES = new Set(["CompiledWasm", "Data", "Text"]);

/**
 * A glob as an esbuild filter (Go regexp) on the import specifier, as wrangler matches it
 * (glob-to-regexp with globstar): `**` spans any folders, `*` stays within one, the rest is literal.
 */
export function globFilter(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (glob.startsWith("**/", i)) {
      re += "(?:[^/]*/)*";
      i += 2;
    } else if (glob.startsWith("**", i)) {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * The rules in effect, as wrangler's `parseRules`: the project's, then the defaults. The first rule
 * of a type without `fallthrough: true` closes the type: later rules of it are dropped (`ignored`
 * names the project's own, unless the closing rule says `fallthrough: false`).
 */
export function effectiveRules(userRules: ModuleRule[] = []): {
  rules: ModuleRule[];
  ignored: string[];
} {
  const all = [...userRules, ...DEFAULT_MODULE_RULES];
  const closedAt = new Map<string, number>();
  const rules: ModuleRule[] = [];
  const ignored: string[] = [];
  for (const [i, rule] of all.entries()) {
    const at = closedAt.get(rule.type);
    if (at !== undefined) {
      if (i < userRules.length && all[at].fallthrough !== false)
        ignored.push(
          `rules[${i}] (${rule.type}) is ignored: rules[${at}] has the same type and no \`fallthrough = true\``,
        );
      continue;
    }
    if (rule.fallthrough !== true) closedAt.set(rule.type, i);
    rules.push(rule);
  }
  return { rules, ignored };
}

// Shared by every inlined file: base64 → bytes (Uint8Array.fromBase64 where the engine has it),
// and the registration of the file under workerd's `/bundle` (node-compat/bundle-files.ts reads
// the same registry).
const DECODE = `export const bundleFile = (name, b) => {
  (globalThis.__cellsBundleFiles ??= new Map()).set(name, b);
  return b;
};
export const bytes = (s) => {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(s);
  const t = atob(s);
  const u = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i);
  return u;
};`;

/**
 * The module a matched file becomes. It also registers the file as workerd's `/bundle/<name>`,
 * named as wrangler uploads it: `<sha1 of its bytes>-<file name>`.
 */
function ruleModule(type: string, file: Buffer, path: string): string {
  const name = JSON.stringify(`${createHash("sha1").update(file).digest("hex")}-${basename(path)}`);
  // A BOM stays part of the text, as wrangler uploads the file's bytes.
  if (type === "Text")
    return [
      'import { bundleFile } from "cellb-rule:decode";',
      `const text = ${JSON.stringify(new TextDecoder("utf-8", { ignoreBOM: true }).decode(file))};`,
      `bundleFile(${name}, () => new TextEncoder().encode(text));`,
      "export default text;",
    ].join("\n");
  const b64 = JSON.stringify(file.toString("base64"));
  return [
    'import { bundleFile, bytes } from "cellb-rule:decode";',
    type === "CompiledWasm"
      ? // Synchronous, as workerd imports a wasm module. A top-level await here would make every
        // importer async, and esbuild's async module inits deadlock on circular imports (the
        // bundle never finishes evaluating). Chromium refuses a synchronous compile over 8 MB
        // only on a page's main thread; projects run in Dedicated Workers and on Node.
        `export default new WebAssembly.Module(bundleFile(${name}, bytes(${b64})));`
      : // `/bundle` keeps its own copy: Worker code may change or transfer the exported buffer.
        `const data = bytes(${b64}); bundleFile(${name}, data.slice()); export default data.buffer;`,
  ].join("\n");
}

/** The esbuild plugin applying `rules` (with the defaults) to a bundle's imports. */
export function moduleRulesPlugin(userRules?: ModuleRule[]): Plugin {
  return {
    name: "cellb-module-rules",
    setup(b) {
      const { rules, ignored } = effectiveRules(userRules);
      for (const message of ignored) console.warn(`[cellb] ${message}`);
      for (const rule of rules) {
        if (!TYPES.has(rule.type)) continue;
        for (const glob of rule.globs)
          b.onResolve({ filter: globFilter(glob) }, async (a) => {
            // files on disk only: in-memory modules (Worker Loader code) bring `{ wasm }` entries
            if (a.namespace !== "file" || a.pluginData?.cellbModuleRule) return undefined;
            // esbuild resolves the file (relative, or a package's through `exports`); the rule loads it
            const r = await b.resolve(a.path.replace(/\?module$/, ""), {
              kind: a.kind,
              importer: a.importer,
              resolveDir: a.resolveDir,
              pluginData: { cellbModuleRule: true },
            });
            if (r.errors.length) return { errors: r.errors };
            // The type is part of the module's identity: one file reached by rules of two types
            // is two modules.
            return { path: r.path, namespace: `cellb-rule-${rule.type}` };
          });
      }
      b.onResolve({ filter: /^cellb-rule:decode$/ }, () => ({
        path: "decode",
        namespace: "cellb-rule-decode",
      }));
      b.onLoad({ filter: /.*/, namespace: "cellb-rule-decode" }, () => ({
        contents: DECODE,
        loader: "js",
      }));
      for (const type of TYPES)
        b.onLoad({ filter: /.*/, namespace: `cellb-rule-${type}` }, (a) => ({
          contents: ruleModule(type, readFileSync(a.path), a.path),
          loader: "js",
        }));
    },
  };
}
