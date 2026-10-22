/**
 * The isolate side: loads the Worker code in THIS realm and serves fetch/RPC for the host.
 * `importCode` is realm specific (data: URL of a bundle on Node, a site URL in browsers).
 */
import { entrypointStub } from "../core/handles.js";
import { deserializeRequest, type PortLike, rpcPort, serializeResponse } from "./protocol.js";

export function serveIsolate(
  port: PortLike,
  importCode: (
    load: any,
    logs: (level: string, args: unknown[]) => void,
  ) => Promise<Record<string, unknown>>,
  opts: { patchConsole?: boolean } = {},
) {
  let module: Record<string, unknown> = {};
  let env: Record<string, unknown> = {};
  const rpc = rpcPort(port, async (m) => {
    if (m.type === "load") {
      // Host bindings: every method call goes back to the host.
      const stubOf = (key: string) =>
        new Proxy(
          {},
          {
            get: (_t, method) =>
              typeof method === "symbol" || method === "then"
                ? undefined
                : (...args: unknown[]) => rpc.request({ type: "stub", key, method, args }),
          },
        );
      env = { ...m.env };
      for (const k of m.stubs as string[]) env[k] = stubOf(k);
      // Logs go to the host (Tail Workers, and the host prints them): through the global
      // console, or — where the realm has other code that logs — a console scoped to the
      // loaded modules (importCode receives the sink).
      const sink = (level: string, args: unknown[]) =>
        rpc.send({ type: "log", level, args: safe(args) });
      if (opts.patchConsole !== false)
        for (const level of ["log", "info", "warn", "error", "debug"] as const)
          console[level] = (...args: unknown[]) => sink(level, args);
      if (m.outbound === "blocked")
        globalThis.fetch = (async () => {
          throw new Error(
            "This worker is not permitted to access the internet via global functions like fetch(). It must use capabilities (such as bindings in 'env') to talk to the outside world.",
          );
        }) as typeof fetch;
      module = await importCode(m, (level, args) =>
        rpc.send({ type: "log", level, args: safe(args) }),
      );
      return Object.fromEntries(Object.entries(module).map(([k, v]) => [k, typeof v]));
    }
    const target = module[m.name];
    if (target === undefined) throw new Error(`Loaded worker does not export "${m.name}"`);
    const stub = entrypointStub(target, env, m.props);
    if (m.type === "fetch")
      return serializeResponse(await stub.fetch(deserializeRequest(m.request)));
    if (m.type === "call") return stub[m.method](...m.args);
    throw new Error(`unknown isolate message ${m.type}`);
  });
  return rpc;
}

const safe = (args: unknown[]) =>
  args.map((a) => {
    try {
      return structuredClone(a);
    } catch {
      return String(a);
    }
  });
