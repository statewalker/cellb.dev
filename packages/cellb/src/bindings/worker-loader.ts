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
  /** Tail Workers: stubs whose `tail(events)` receives each invocation's logs and exceptions. */
  tails?: { tail(events: TailEvent[]): unknown }[];
}

export interface TailLog {
  message: unknown[];
  level: string;
  timestamp: number;
}

export interface TailEvent {
  scriptName: string;
  outcome: "ok" | "exception";
  eventTimestamp: number;
  event: { request?: { url: string; method: string } } | null;
  logs: TailLog[];
  exceptions: { name: string; message: string; timestamp: number }[];
  diagnosticsChannelEvents: unknown[];
}

/** Where the `console` of loaded code writes (the host forwards to the real console too). */
export type LogSink = (level: string, args: unknown[]) => void;

/** Compiles a WorkerCode into a module namespace (host specific: esbuild on Node, webrun-modules in browsers). */
export type ModuleLoader = (
  id: string,
  code: WorkerCode,
  logs?: LogSink,
) => Promise<Record<string, unknown>>;

/**
 * The Worker Loader binding (`worker_loaders` in wrangler config): runtime-loaded code,
 * cached by id; the callback runs only when the id is not loaded yet.
 */
export function workerLoader(load: ModuleLoader) {
  type Loaded = {
    module: Record<string, unknown>;
    env: unknown;
    code: WorkerCode;
    logs: TailLog[];
  };
  const cache = new Map<string, Promise<Loaded>>();
  return {
    get(id: string, getCode: () => WorkerCode | Promise<WorkerCode>) {
      const loaded = () => {
        let p = cache.get(id);
        if (!p) {
          p = (async () => {
            const code = await getCode();
            const logs: TailLog[] = [];
            const sink: LogSink = (level, message) =>
              logs.push({ level, message, timestamp: Date.now() });
            return { module: await load(id, code, sink), env: code.env ?? {}, code, logs };
          })();
          p.catch(() => cache.delete(id));
          cache.set(id, p);
        }
        return p;
      };
      /** Runs one invocation of loaded code, then hands its logs/exceptions to the Tail Workers. */
      const traced = async <T>(
        l: Loaded,
        request: Request | undefined,
        run: () => Promise<T>,
      ): Promise<T> => {
        const from = l.logs.length;
        const t0 = Date.now();
        const exceptions: TailEvent["exceptions"] = [];
        let outcome: TailEvent["outcome"] = "ok";
        try {
          return await run();
        } catch (e) {
          outcome = "exception";
          exceptions.push({
            name: (e as Error)?.name ?? "Error",
            message: String((e as Error)?.message ?? e),
            timestamp: Date.now(),
          });
          throw e;
        } finally {
          const event: TailEvent = {
            scriptName: id,
            outcome,
            eventTimestamp: t0,
            event: request ? { request: { url: request.url, method: request.method } } : null,
            logs: l.logs.splice(from),
            exceptions,
            diagnosticsChannelEvents: [],
          };
          for (const t of l.code.tails ?? []) void Promise.resolve(t.tail([event])).catch(() => {});
        }
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
          return new Proxy(
            {},
            {
              get(_t, prop) {
                if (prop === "then" || typeof prop === "symbol") return undefined;
                return async (...args: unknown[]) => {
                  const l = await loaded();
                  const stub = entrypointStub(l.module[name], l.env, options.props);
                  const request =
                    prop === "fetch"
                      ? new Request(args[0] as RequestInfo, args[1] as RequestInit)
                      : undefined;
                  return traced(l, request, () =>
                    stub[prop as string](...(request ? [request] : args)),
                  );
                };
              },
            },
          );
        },
      };
    },
  };
}
