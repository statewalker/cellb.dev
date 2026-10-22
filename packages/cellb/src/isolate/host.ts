import type { LogSink, ModuleLoader, WorkerCode } from "../bindings/worker-loader.js";
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
    return Object.fromEntries(Object.keys(exports).map((k) => [k, facade(k)]));
  };
}
