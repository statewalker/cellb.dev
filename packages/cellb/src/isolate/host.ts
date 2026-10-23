import type { LogSink, ModuleLoader, WorkerCode } from "../bindings/worker-loader.js";
import type { IsolatedClass } from "../core/handles.js";
import type { CellBackup, CellDurability } from "../ports.js";

/** Key of the isolate's class factory on a module facade (see getDurableObjectClass). */
export const ISOLATED = Symbol.for("webrun-cells.isolated-classes");

import {
  deserializeResponse,
  type PortLike,
  rpcPort,
  serializeRequest,
  splitEnv,
} from "./protocol.js";

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
  storage?: () => { durability?: CellDurability; backup?: CellBackup };
  spawn(id: string): { port: PortLike; terminate(): void };
  prepare(id: string, code: WorkerCode): Promise<{ source?: string; url?: string }>;
}): ModuleLoader {
  return async (id: string, code: WorkerCode, logs?: LogSink) => {
    const env = (code.env ?? {}) as Record<string, any>;
    const { plain, stubs } = splitEnv(env);
    const outbound = code.globalOutbound === null ? "blocked" : undefined;
    if (code.globalOutbound && typeof code.globalOutbound === "object") stubs.push("__outbound");
    const where = await opts.prepare(id, code);
    const isolate = opts.spawn(id);
    const rpc = rpcPort(isolate.port, async (m) => {
      if (m.type === "stub") {
        const target = m.key === "__outbound" ? code.globalOutbound : env[m.key];
        return (target as any)[m.method](...m.args);
      }
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
                ? () => rpc.request<Uint8Array | undefined>({ type: "image", token })
                : token,
          });
        }
        return;
      }
      if (m.type === "log") {
        logs?.(m.level, m.args);
        (console as any)[m.level](...m.args);
      }
    });
    const exports = await rpc.request<Record<string, string>>({
      type: "load",
      ...where,
      env: plain,
      stubs,
      outbound,
    });
    const facade = (name: string) =>
      new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then" || typeof prop === "symbol") return undefined;
            if (prop === "fetch")
              return async (req: Request) =>
                deserializeResponse(
                  await rpc.request({ type: "fetch", name, request: await serializeRequest(req) }),
                );
            return (...args: unknown[]) => rpc.request({ type: "call", name, method: prop, args });
          },
        },
      );
    const module: Record<string | symbol, unknown> = Object.fromEntries(
      Object.keys(exports).map((k) => [k, facade(k)]),
    );
    // Durable Object classes of the loaded code run in the isolate too (facets).
    module[ISOLATED] = (className: string): IsolatedClass => ({
      fetch: async (cellKey, req) =>
        deserializeResponse(
          await rpc.request({
            type: "object",
            op: "fetch",
            className,
            cellKey,
            request: await serializeRequest(req),
          }),
        ),
      call: (cellKey, method, args) =>
        rpc.request({ type: "object", op: "call", className, cellKey, method, args }),
      restart: (cellKey) => rpc.request({ type: "object", op: "restart", className, cellKey }),
      delete: (cellKey) => rpc.request({ type: "object", op: "delete", className, cellKey }),
      attach: (cellKey, epoch) =>
        rpc.request({ type: "object", op: "attach", className, cellKey, epoch }),
    });
    return module as Record<string, unknown>;
  };
}
