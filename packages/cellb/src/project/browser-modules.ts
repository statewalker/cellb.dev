import {
  type LogSink,
  type ModuleLoader,
  moduleText,
  outboundFetch,
  type WorkerCode,
} from "../bindings/worker-loader.js";
import { ctxExports } from "../core/handles.js";
import { registerWorkerScope, workerScope } from "./worker-scope.js";

/**
 * `cloudflare:workers` for code imported in a browser realm: the runtime's classes from
 * `globalThis.__cellsWorkersModule`, and `env`/`exports` from `scope` (an expression): the
 * realm's Worker by default.
 */
const workersModuleShim = (scope = "m") =>
  `const m = globalThis.__cellsWorkersModule; const s = ${scope}; export const DurableObject = m.DurableObject, WorkerEntrypoint = m.WorkerEntrypoint, WorkflowEntrypoint = m.WorkflowEntrypoint, RpcTarget = m.RpcTarget, env = s.env, exports = s.exports; export default m;`;

/** `cloudflare:workers` of a project bundle: its `env`/`exports` are the realm's Worker's. */
export const WORKERS_MODULE_SHIM = workersModuleShim();

/**
 * Worker Loader in a browser realm: each module of a WorkerCode becomes a Blob-URL ES
 * module. `cloudflare:workers` resolves to a shim reading the runtime's own classes from
 * `globalThis.__cellsWorkersModule` and this load's own `env`/`exports`; relative imports
 * resolve to the Blob URLs of sibling modules; with a log sink the module gets a module-scoped
 * `console` (Tail Workers).
 */
export function browserModuleLoader(): ModuleLoader {
  return async (_id: string, code: WorkerCode, logs?: LogSink) => {
    const env = code.env ?? {};
    const scope = workerScope(env);
    const shimUrl = URL.createObjectURL(
      new Blob(
        [
          workersModuleShim(
            `globalThis.__cellsWorkerScopes[${JSON.stringify(registerWorkerScope(scope))}]`,
          ),
        ],
        {
          type: "text/javascript",
        },
      ),
    );
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
    scope.bind({ env, exports: ctxExports(module, env) });
    return module;
  };
}
