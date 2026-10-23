/**
 * The isolate side: loads the Worker code in THIS realm and serves fetch/RPC for the host.
 * `importCode` is realm specific (data: URL of a bundle on Node, a site URL in browsers).
 */
import { entrypointStub } from "../core/handles.js";
import { runInDurableObject } from "../core/namespace.js";
import { type CellRuntime, createCellRuntime, type WorkerModule } from "../core/runtime.js";
import type { OpenCellSql } from "../ports.js";
import { deserializeRequest, type PortLike, rpcPort, serializeResponse } from "./protocol.js";

export function serveIsolate(
  port: PortLike,
  importCode: (
    load: any,
    logs: (level: string, args: unknown[]) => void,
  ) => Promise<Record<string, unknown>>,
  opts: {
    patchConsole?: boolean;
    /**
     * Storage for Durable Object classes run INSIDE this isolate (facets of loaded code):
     * each facet is a cell of an isolate-local runtime, with its own SQLite.
     */
    openSql?: (load: any) => OpenCellSql | Promise<OpenCellSql>;
  } = {},
) {
  let module: Record<string, unknown> = {};
  const runtimes = new Map<string, CellRuntime>();
  // Facet logging through the host: the isolate-local cell key → the facet's key in the
  // root's storage (celld: <root>/facets/<sha>) and the root's epoch.
  const facetKeys = new Map<string, { key: string; epoch?: number }>();
  const images = new Map<number, () => unknown>();
  let nextImage = 0;
  const hostLogged = (internal: string) => facetKeys.get(internal);
  const durability = {
    capturePages: true,
    async committed(cellKey: string, info: any) {
      const f = hostLogged(cellKey);
      if (!f) return;
      const token = ++nextImage;
      if (typeof info.image === "function") images.set(token, info.image);
      try {
        await rpc.request({
          type: "durable",
          op: "committed",
          cellKey: f.key,
          info: {
            seq: info.seq,
            pages: info.pages,
            epoch: f.epoch,
            image: typeof info.image === "function" ? token : info.image,
          },
        });
      } finally {
        images.delete(token);
      }
    },
  };
  const backup = {
    async load(cellKey: string) {
      const f = hostLogged(cellKey);
      return f
        ? ((await rpc.request({ type: "durable", op: "load", cellKey: f.key })) as
            | Uint8Array
            | undefined)
        : undefined;
    },
    async save() {},
  };
  let loadMsg: any;
  let sql: Promise<OpenCellSql> | undefined;
  const objectRuntime = async (className: string) => {
    let rt = runtimes.get(className);
    if (!rt) {
      if (!opts.openSql)
        throw new Error("this isolate cannot host Durable Object classes (no storage)");
      sql ??= Promise.resolve(opts.openSql(loadMsg));
      const openSql = await sql;
      if (runtimes.has(className)) return runtimes.get(className)!;
      if (typeof module[className] !== "function")
        throw new Error(`Loaded worker does not export class "${className}"`);
      rt = createCellRuntime({
        worker: { ...(module as WorkerModule), default: {} },
        durableObjects: { [className]: { className } },
        openSql,
        vars: env, // the loaded Worker's env: plain values and host stubs
        durability: durability as never,
        facets: true, // rows move to this run's scope on open, as celld does for facets
        backup: backup as never,
      });
      runtimes.set(className, rt);
    }
    return rt;
  };
  let env: Record<string, unknown> = {};
  const rpc = rpcPort(port, async (m) => {
    if (m.type === "load") {
      loadMsg = m;
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
    if (m.type === "image") return await images.get(m.token)?.();
    if (m.type === "object") {
      // A facet of loaded code: the object lives here, named by the parent's facet cell key.
      const rt = await objectRuntime(m.className);
      const ns = rt.env[m.className] as {
        getByName(n: string): any;
        idFromName(n: string): { toString(): string };
      };
      const stub = ns.getByName(m.cellKey);
      const key = `${m.className}/${ns.idFromName(m.cellKey).toString()}`;
      if (m.op === "attach") {
        facetKeys.set(key, { key: m.cellKey, epoch: m.epoch });
        return;
      }
      if (m.op === "fetch")
        return serializeResponse(await stub.fetch(deserializeRequest(m.request)));
      if (m.op === "call") return stub[m.method](...m.args);
      if (m.op === "restart") return rt.restartObject(key);
      if (m.op === "delete") {
        await runInDurableObject(
          stub,
          (_o: unknown, ctx: { storage: { deleteAll(): Promise<void> } }) =>
            ctx.storage.deleteAll(),
        );
        return rt.restartObject(key);
      }
      throw new Error(`unknown object op ${m.op}`);
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
