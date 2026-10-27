import {
  type LogSink,
  type ModuleLoader,
  moduleText,
  outboundFetch,
  type WorkerCode,
} from "../bindings/worker-loader.js";
import { ctxExports } from "../core/handles.js";
import { workerScope } from "./worker-scope.js";

/** `cloudflare:workers`' classes and default export, read from `globalThis.__cellsWorkersModule`. */
export const WORKERS_CLASSES =
  "const m = globalThis.__cellsWorkersModule; export const DurableObject = m.DurableObject, WorkerEntrypoint = m.WorkerEntrypoint, WorkflowEntrypoint = m.WorkflowEntrypoint, RpcTarget = m.RpcTarget; export default m;";

/**
 * `cloudflare:workers` for a project's own bundle: the classes, and the project's `env` and
 * `exports` from `globalThis.__cellsProjectScope` (set by `browserProjectRuntime`, and by
 * `serveIsolate` for the loaded Worker an isolate runs). The shim is
 * bundled with the Worker, so it declares no names beyond its exports: esbuild would rename the
 * Worker's own variables of the same name, and those names show in error messages.
 */
export const PROJECT_WORKERS_MODULE_SHIM = `${WORKERS_CLASSES} export const env = globalThis.__cellsProjectScope?.env ?? {}, exports = globalThis.__cellsProjectScope?.exports ?? {};`;

/**
 * Worker Loader in a browser realm: each module of a WorkerCode becomes a Blob-URL ES
 * module. `cloudflare:workers` resolves to a shim reading the runtime's own classes from
 * `globalThis.__cellsWorkersModule` and the loaded code's own `env` and `exports` (or to
 * `workersModuleShim`, the same for every load); relative imports resolve to the Blob URLs of
 * sibling modules; with a log sink the module gets a module-scoped `console` (Tail Workers).
 */
export function browserModuleLoader(workersModuleShim?: string): ModuleLoader {
  const blob = (text: string) => URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
  const fixedShimUrl = workersModuleShim && blob(workersModuleShim);
  return async (_id: string, code: WorkerCode, logs?: LogSink) => {
    const env = code.env ?? {};
    const scope = fixedShimUrl ? undefined : workerScope(env);
    let shimUrl = fixedShimUrl;
    if (scope) {
      const key = `s${Math.random().toString(36).slice(2)}`;
      const g = globalThis as Record<string, unknown>;
      g.__cellsWorkerScopes ??= {};
      (g.__cellsWorkerScopes as Record<string, unknown>)[key] = scope;
      shimUrl = blob(
        `${WORKERS_CLASSES} const s = globalThis.__cellsWorkerScopes[${JSON.stringify(key)}]; export const env = s.env, exports = s.exports;`,
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
    const urls = new Map<string, string>();
    const source = (name: string) => {
      const m = code.modules[name];
      if (m === undefined) throw new Error(`Worker Loader: module "${name}" not found`);
      return moduleText(m);
    };
    const urlOf = (name: string): string => {
      const known = urls.get(name);
      if (known) return known;
      const base = name.includes("/") ? name.slice(0, name.lastIndexOf("/") + 1) : "";
      const text = source(name).replace(
        /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g,
        (all, pre, q, spec: string) => {
          if (spec === "cloudflare:workers") return `${pre}${q}${shimUrl}${q}`;
          if (spec.startsWith("./") || spec.startsWith("../"))
            return `${pre}${q}${urlOf(new URL(spec, `file:///${base}`).pathname.slice(1))}${q}`;
          return all;
        },
      );
      const url = URL.createObjectURL(
        new Blob([consolePrelude + text], { type: "text/javascript" }),
      );
      urls.set(name, url);
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
