import {
  type LogSink,
  type ModuleLoader,
  outboundFetch,
  type WorkerCode,
} from "../bindings/worker-loader.js";
import { ISOLATED, type IsolatedClass, ON_ABORT } from "../core/handles.js";
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
}): IsolatedModuleLoader {
  // Every isolate this loader started: `close()` ends them (a project runtime's close does).
  const isolates = new Set<{ terminate(): void; goAway?(): Promise<unknown> }>();
  const load = async (id: string, code: WorkerCode, logs?: LogSink) => {
    // The env crosses as any call does: bindings and other stubs by reference.
    const env: Record<string, unknown> = { ...code.env };
    // The loaded code's global fetch(): blocked in the isolate, or sent back here to the Fetcher.
    const fetcher = outboundFetch(code);
    const outbound = code.globalOutbound === null ? "blocked" : fetcher ? "fetcher" : undefined;
    const where = await opts.prepare(id, code);
    const isolate = opts.spawn(id);
    const running: { terminate(): void; goAway?(): Promise<unknown> } = {
      terminate: () => isolate.terminate(),
    };
    isolates.add(running);
    const onAbort: (() => void)[] = [];
    // The loaded code called `abortIsolate()`: calls in flight and later ones reject with
    // workerd's error, the isolate ends, and the loader forgets this module.
    const abort = (m: { reason: string; reference: string }) => {
      if (!isolates.delete(running)) return;
      console.error(`cellb: loaded Worker "${id}" aborted its isolate: ${m.reason}`);
      void close(new Error(`internal error; reference = ${m.reference}`)).finally(() =>
        isolate.terminate(),
      );
      for (const f of onAbort.splice(0)) f();
    };
    const { call, fetch, close } = await hostPort(
      isolate.port,
      async (m) => {
        if (m.type === "abort") return abort(m);
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
    // Before it ends, the isolate tells its sockets' clients it is going away (1001): their
    // frames go straight to the isolate (protocol.ts), so only it can.
    running.goAway = () => call({ type: "goAway" });
    const exports = await call<Record<string, string>>({
      type: "load",
      ...where,
      env,
      outbound,
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
    module[ISOLATED] = (className: string): IsolatedClass => ({
      fetch: (cellKey, req) => fetch({ className, cellKey }, req),
      call: (cellKey, method, args) =>
        call({ type: "object", op: "call", className, cellKey, method, args }),
      restart: (cellKey) => call({ type: "object", op: "restart", className, cellKey }),
      delete: (cellKey) => call({ type: "object", op: "delete", className, cellKey }),
      attach: (cellKey, epoch, idName) =>
        call({ type: "object", op: "attach", className, cellKey, epoch, idName }),
    });
    module[ON_ABORT] = (f: () => void) => onAbort.push(f);
    return module as Record<string, unknown>;
  };
  return Object.assign(load, {
    close(): Promise<void> {
      const ending = [...isolates];
      isolates.clear();
      // Each isolate closes its sockets (1001), within a second; then it ends.
      return Promise.all(
        ending.map(async (isolate) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            isolate.goAway?.().catch(() => {}),
            new Promise((r) => {
              timer = setTimeout(r, 1_000);
            }),
          ]);
          clearTimeout(timer);
          isolate.terminate();
        }),
      ).then(() => {});
    },
  });
}

/** A Worker Loader's module loader whose isolates end with `close()`. */
export type IsolatedModuleLoader = ModuleLoader & { close(): Promise<void> };
