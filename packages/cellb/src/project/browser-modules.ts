import {
  IMPORT_FROM,
  prefixModule,
  resolveModuleName,
  routeDynamicImports,
} from "../bindings/module-registry.js";
import {
  compileWasmModules,
  type LogSink,
  type ModuleLoader,
  moduleText,
  outboundFetch,
  type WorkerCode,
} from "../bindings/worker-loader.js";
import { ctxExports } from "../core/handles.js";
import { FUNCTION_IMPORT } from "../isolate/function-imports.js";
import { rewriteModuleSpecifiers } from "./module-specifiers.js";
import { workerScope } from "./worker-scope.js";

const WORKERS_CLASSES =
  "const m = globalThis.__cellsWorkersModule; export const DurableObject = m.DurableObject, WorkerEntrypoint = m.WorkerEntrypoint, WorkflowEntrypoint = m.WorkflowEntrypoint, RpcTarget = m.RpcTarget, abortIsolate = m.abortIsolate; export default m;";

/**
 * `cloudflare:workers` for a project's own bundle: the classes, and the project's `env` and
 * `exports` from `globalThis.__cellsProjectScope` (set by `browserProjectRuntime`, and by
 * `serveIsolate` for the loaded Worker an isolate runs). The shim is
 * bundled with the Worker, so it declares no names beyond its exports: esbuild would rename the
 * Worker's own variables of the same name, and those names show in error messages.
 */
export const PROJECT_WORKERS_MODULE_SHIM = `${WORKERS_CLASSES} export const env = globalThis.__cellsProjectScope?.env ?? {}, exports = globalThis.__cellsProjectScope?.exports ?? {}, waitUntil = (p) => globalThis.__cellsProjectScope?.waitUntil(p);`;

/**
 * Worker Loader in a browser realm: each module of a WorkerCode becomes a Blob-URL ES
 * module. `cloudflare:workers` resolves to a shim reading the runtime's own classes from
 * `globalThis.__cellsWorkersModule` and the loaded code's own `env` and `exports` (or to
 * `workersModuleShim`, the same for every load); relative imports resolve to the Blob URLs of
 * sibling modules; with a log sink the module gets a module-scoped `console` (Tail Workers).
 */
export function browserModuleLoader(
  workersModuleShim?: string,
  opts: {
    /**
     * This realm is the loaded Worker's own (an isolate): an `import()` in code it builds with
     * `Function` resolves against its modules too (isolate/function-imports.ts).
     */
    functionImports?: boolean;
  } = {},
): ModuleLoader {
  const blob = (text: string) => URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
  const fixedShimUrl = workersModuleShim && blob(workersModuleShim);
  return async (_id: string, loaded: WorkerCode, logs?: LogSink) => {
    const code = await compileWasmModules(loaded);
    const env = code.env ?? {};
    const scope = fixedShimUrl ? undefined : workerScope(env);
    let shimUrl = fixedShimUrl;
    if (scope) {
      const key = `s${Math.random().toString(36).slice(2)}`;
      const g = globalThis as Record<string, unknown>;
      g.__cellsWorkerScopes ??= {};
      (g.__cellsWorkerScopes as Record<string, unknown>)[key] = scope;
      shimUrl = blob(
        `${WORKERS_CLASSES} const s = globalThis.__cellsWorkerScopes[${JSON.stringify(key)}]; export const env = s.env, exports = s.exports, waitUntil = s.waitUntil;`,
      );
    }
    let consolePrelude = "";
    if (logs) {
      const key = `c${Math.random().toString(36).slice(2)}`;
      const g = globalThis as Record<string, unknown>;
      g.__cellsConsoles ??= {};
      const real = globalThis.console;
      const wrap =
        (level: "log" | "info" | "warn" | "error" | "debug") =>
        (...args: unknown[]) => {
          logs(level, args);
          real[level](...args);
        };
      (g.__cellsConsoles as Record<string, unknown>)[key] = Object.assign(Object.create(real), {
        log: wrap("log"),
        info: wrap("info"),
        warn: wrap("warn"),
        error: wrap("error"),
        debug: wrap("debug"),
      });
      consolePrelude = `const console = globalThis.__cellsConsoles[${JSON.stringify(key)}];\n`;
    }
    const outbound = outboundFetch(code);
    if (outbound) {
      const key = `o${Math.random().toString(36).slice(2)}`;
      const g = globalThis as Record<string, unknown>;
      g.__cellsOutbound ??= {};
      (g.__cellsOutbound as Record<string, unknown>)[key] = outbound;
      consolePrelude += `const fetch = globalThis.__cellsOutbound[${JSON.stringify(key)}];\n`;
    }
    // `import()` the Blob URLs cannot link (a computed specifier, a module's whole name) resolves
    // against this load's modules at run time (module-registry.ts).
    const names = new Set(Object.keys(code.modules));
    const importsKey = `i${Math.random().toString(36).slice(2)}`;
    const g = globalThis as Record<string, unknown>;
    g.__cellsImports ??= {};
    const imports = g.__cellsImports as Record<string, unknown>;
    imports[importsKey] = (spec: unknown, importer: string) => {
      const name = resolveModuleName(String(spec), importer, names);
      return import(/* @vite-ignore */ name === undefined ? String(spec) : urlOf(name));
    };
    // Code built with `Function` has no module of its own: it resolves from the main module.
    if (opts.functionImports)
      g[FUNCTION_IMPORT] = (spec: unknown) =>
        (imports[importsKey] as (s: unknown, i: string) => Promise<unknown>)(spec, code.mainModule);
    const routed = (name: string) => {
      const text = source(name);
      const out = routeDynamicImports(text, name);
      return out === undefined
        ? text
        : prefixModule(
            out,
            `const ${IMPORT_FROM} = globalThis.__cellsImports[${JSON.stringify(importsKey)}]; `,
          );
    };
    // An import of none of the loaded modules fails when it runs, as on workerd, not when the
    // importing module loads: Kitesurf's page runtime has `import("./__ks_user_classic_regular.js")`
    // and loads that module only for a page with classic scripts.
    const missingUrl = (spec: string, importer: string) =>
      URL.createObjectURL(
        new Blob(
          [
            `throw new Error(${JSON.stringify(`No such module "${spec}" (imported from "${importer}")`)});`,
          ],
          { type: "text/javascript" },
        ),
      );
    const urls = new Map<string, string>();
    // Modules whose Blob URL is being made: a Blob URL exists only once its text (with its
    // imports' URLs) does, so modules that import each other cannot be loaded this way.
    const making: string[] = [];
    const source = (name: string) => {
      const m = code.modules[name];
      if (m === undefined) throw new Error(`Worker Loader: module "${name}" not found`);
      return moduleText(m, name, names);
    };
    const urlOf = (name: string): string => {
      const known = urls.get(name);
      if (known) return known;
      if (making.includes(name))
        throw new Error(
          `Worker Loader: modules import each other (${[...making.slice(making.indexOf(name)), name].join(" → ")}); a browser realm loads each module from a Blob URL, which cannot form a cycle`,
        );
      making.push(name);
      const base = name.includes("/") ? name.slice(0, name.lastIndexOf("/") + 1) : "";
      // Only the module's own imports: the same words in a string, a template or a comment are
      // not imports (a code generator's template may well contain `from "cloudflare:workers"`).
      const text = rewriteModuleSpecifiers(routed(name), (spec) => {
        if (spec === "cloudflare:workers") return shimUrl;
        if (spec.startsWith("./") || spec.startsWith("../")) {
          const target = new URL(spec, `file:///${base}`).pathname.slice(1);
          return names.has(target) ? urlOf(target) : missingUrl(spec, name);
        }
        return undefined;
      });
      const url = URL.createObjectURL(
        new Blob([consolePrelude + text], { type: "text/javascript" }),
      );
      urls.set(name, url);
      making.pop();
      return url;
    };
    const module = (await import(/* @vite-ignore */ urlOf(code.mainModule))) as Record<
      string,
      unknown
    >;
    scope?.bind({ env, exports: ctxExports(module, env) });
    return module;
  };
}
