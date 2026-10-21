import { classHandle, entrypointStub } from "../core/handles.js";
import type { DurableObjectClass } from "../core/object-host.js";

/** What `env.LOADER.get(id, () => code)` returns from its callback (workerd's WorkerCode). */
export interface WorkerCode {
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<
    string,
    string | { js?: string; esModule?: string; text?: string; json?: unknown }
  >;
  env?: Record<string, unknown>;
  globalOutbound?: unknown;
}

/** Compiles a WorkerCode into a module namespace (host specific: esbuild on Node, webrun-modules in browsers). */
export type ModuleLoader = (id: string, code: WorkerCode) => Promise<Record<string, unknown>>;

/**
 * The Worker Loader binding (`worker_loaders` in wrangler config): runtime-loaded code,
 * cached by id; the callback runs only when the id is not loaded yet.
 */
export function workerLoader(load: ModuleLoader) {
  const cache = new Map<string, Promise<{ module: Record<string, unknown>; env: unknown }>>();
  return {
    get(id: string, getCode: () => WorkerCode | Promise<WorkerCode>) {
      const loaded = () => {
        let p = cache.get(id);
        if (!p) {
          p = (async () => {
            const code = await getCode();
            return { module: await load(id, code), env: code.env ?? {} };
          })();
          p.catch(() => cache.delete(id));
          cache.set(id, p);
        }
        return p;
      };
      return {
        getDurableObjectClass(name: string) {
          return classHandle(async () => {
            const { module, env } = await loaded();
            const cls = module[name];
            if (typeof cls !== "function")
              throw new Error(`Loaded worker "${id}" does not export class "${name}"`);
            return { cls: cls as DurableObjectClass, env };
          });
        },
        getEntrypoint(name = "default", options: { props?: unknown } = {}) {
          let stub: Record<string, any> | undefined;
          const resolve = async () => {
            if (stub) return stub;
            const { module, env } = await loaded();
            stub = entrypointStub(module[name], env, options.props);
            return stub;
          };
          return new Proxy(
            {},
            {
              get(_t, prop) {
                if (prop === "then" || typeof prop === "symbol") return undefined;
                return async (...args: unknown[]) => (await resolve())[prop as string](...args);
              },
            },
          );
        },
      };
    },
  };
}
