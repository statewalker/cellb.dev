import {
  type LogSink,
  type ModuleLoader,
  outboundFetch,
  type WorkerCode,
} from "../bindings/worker-loader.js";
import { ISOLATED, type IsolatedClass } from "../core/handles.js";
import type { CellStorage } from "../ports.js";
import { hostPort, type PortLike } from "./protocol.js";

/**
 * Worker Loader whose code runs in a separate realm per loaded Worker (an isolate). Returns
 * a module facade: each export is an object whose `fetch()` and methods cross the port.
 * Durable Object classes cannot cross (their storage API is synchronous): use an in-realm
 * loader for `getDurableObjectClass` (see `workerLoader(load, { classes })`).
 */
export function isolatedModuleLoader(opts: {
  /**
   * The host's storage, so facets of loaded code are logged and restored like the root's
   * own (celld: one stream per facet under the root, the root's epoch).
   */
  storage?: () => CellStorage | undefined;
  spawn(id: string): { port: PortLike; terminate(): void };
  prepare(id: string, code: WorkerCode): Promise<{ source?: string; url?: string }>;
}): ModuleLoader {
  return async (id: string, code: WorkerCode, logs?: LogSink) => {
    // The env crosses as any call does: bindings and other stubs by reference.
    const env: Record<string, unknown> = { ...code.env };
    // The loaded code's global fetch(): blocked in the isolate, or sent back here to the Fetcher.
    const fetcher = outboundFetch(code);
    const outbound = code.globalOutbound === null ? "blocked" : fetcher ? "fetcher" : undefined;
    const where = await opts.prepare(id, code);
    const isolate = opts.spawn(id);
    const { call, fetch } = await hostPort(
      isolate.port,
      async (m) => {
        if (m.type === "durable") {
          const st = opts.storage?.() ?? {};
          if (m.op === "load") return st.backup?.load?.(m.cellKey);
          if (m.op === "committed" && st.durability) {
            const info = m.info;
            const token = info.image;
            await st.durability.committed(m.cellKey, {
              ...info,
              image:
                typeof token === "number"
                  ? () => call<Uint8Array | undefined>({ type: "image", token })
                  : token,
            });
          }
          return;
        }
        if (m.type === "log") {
          logs?.(m.level, m.args);
          (console as any)[m.level](...m.args);
        }
      },
      fetcher,
    );
    const exports = await call<Record<string, string>>({
      type: "load",
      ...where,
      env,
      outbound,
      flags: code.compatibilityFlags ?? [],
    });
    const facade = (name: string) =>
      new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then" || typeof prop === "symbol") return undefined;
            // Called as a plain-object entrypoint (entrypointStub): `ctx` comes last, after `env`
            // (the isolate has its own); its props cross with the call.
            if (prop === "fetch")
              return (req: Request, _env: unknown, ctx?: { props?: unknown }) =>
                fetch({ name, props: ctx?.props }, req);
            return (...args: unknown[]) => {
              const ctx = args.pop() as { props?: unknown };
              args.pop();
              return call({ type: "call", name, method: prop, args, props: ctx.props });
            };
          },
        },
      );
    const module: Record<string | symbol, unknown> = Object.fromEntries(
      Object.keys(exports).map((k) => [k, facade(k)]),
    );
    // Durable Object classes of the loaded code run in the isolate too (facets).
    // `props`: the facets' `ctx.props`, sent once, when each is attached.
    module[ISOLATED] = (className: string, props?: unknown): IsolatedClass => ({
      fetch: (cellKey, req) => fetch({ className, cellKey }, req),
      call: (cellKey, method, args) =>
        call({ type: "object", op: "call", className, cellKey, method, args }),
      restart: (cellKey) => call({ type: "object", op: "restart", className, cellKey }),
      delete: (cellKey) => call({ type: "object", op: "delete", className, cellKey }),
      attach: (cellKey, epoch) =>
        call({ type: "object", op: "attach", className, cellKey, epoch, props }),
    });
    return module as Record<string, unknown>;
  };
}
