import {
  type LogSink,
  type ModuleLoader,
  outboundFetch,
  type WorkerCode,
} from "../bindings/worker-loader.js";

/**
 * Worker Loader in a browser realm: each module of a WorkerCode becomes a Blob-URL ES
 * module. `cloudflare:workers` resolves to a shim reading the runtime's own classes from
 * `globalThis.__cellsWorkersModule`; relative imports resolve to the Blob URLs of sibling
 * modules; with a log sink the module gets a module-scoped `console` (Tail Workers).
 */
export function browserModuleLoader(workersModuleShim: string): ModuleLoader {
  const shimUrl = URL.createObjectURL(new Blob([workersModuleShim], { type: "text/javascript" }));
  return async (_id: string, code: WorkerCode, logs?: LogSink) => {
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
      return typeof m === "string"
        ? m
        : (m.js ?? m.esModule ?? `export default ${JSON.stringify(m.text ?? m.json)};`);
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
    return (await import(/* @vite-ignore */ urlOf(code.mainModule))) as Record<string, unknown>;
  };
}
