/**
 * The isolate side: loads the Worker code in THIS realm and serves fetch/RPC for the host.
 * `importCode` is realm specific (data: URL of a bundle on Node, a site URL in browsers).
 */
import { ctxExports, entrypointStub } from "../core/handles.js";
import { runInDurableObject } from "../core/namespace.js";
import { type CellRuntime, createCellRuntime, type WorkerModule } from "../core/runtime.js";
import type { Lease, LeaseHandle, OpenCellSql } from "../ports.js";
import { type FetchTarget, isolatePort, type PortLike } from "./protocol.js";

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
        await call({
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
        ? ((await call({ type: "durable", op: "load", cellKey: f.key })) as Uint8Array | undefined)
        : undefined;
    },
    async save() {},
  };
  // The host holds the root's lease and attaches each facet with its epoch: handing that epoch
  // out as the facet's own lease makes its ObjectHost rebuild the local database from the
  // bucket when it opens, as a root does under a lease (a pool kept from an earlier ownership
  // is older than what other nodes wrote since). Without an epoch, the local file stays primary.
  const ownership: Lease = {
    async tryAcquire(cellKey) {
      const lost = new AbortController().signal; // fencing stays with the root's lease, in the host
      return {
        name: cellKey,
        epoch: hostLogged(cellKey)?.epoch,
        lost,
        release: async () => {},
      } as LeaseHandle;
    },
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
        storage: { durability, backup, ownership },
        facets: true, // rows move to this run's scope on open, as celld does for facets
      });
      runtimes.set(className, rt);
    }
    return rt;
  };
  let env: Record<string, unknown> = {};
  let exports: Record<string, unknown> = {};
  // A facet of loaded code: the object lives here, named by the parent's facet cell key.
  const facet = async (className: string, cellKey: string) => {
    const rt = await objectRuntime(className);
    const ns = rt.env[className] as {
      getByName(n: string): any;
      idFromName(n: string): { toString(): string };
    };
    return { rt, stub: ns.getByName(cellKey), key: `${className}/${ns.idFromName(cellKey)}` };
  };
  const exported = (name: string, props?: unknown) => {
    const target = module[name];
    if (target === undefined) throw new Error(`Loaded worker does not export "${name}"`);
    return entrypointStub(target, env, props, exports);
  };
  const fetchTarget = async (t: FetchTarget, req: Request): Promise<Response> =>
    "className" in t
      ? (await facet(t.className, t.cellKey)).stub.fetch(req)
      : exported(t.name, t.props).fetch(req);
  const handle = async (m: any) => {
    if (m.type === "load") {
      loadMsg = m;
      env = m.env; // host bindings arrive as stubs: every call goes back to the host
      // Logs go to the host (Tail Workers, and the host prints them): through the global
      // console, or — where the realm has other code that logs — a console scoped to the
      // loaded modules (importCode receives the sink).
      const sink = (level: string, args: unknown[]) =>
        call({ type: "log", level, args: safe(args) }).catch(() => {});
      if (opts.patchConsole !== false)
        for (const level of ["log", "info", "warn", "error", "debug"] as const)
          console[level] = (...args: unknown[]) => sink(level, args);
      if (m.outbound === "blocked")
        globalThis.fetch = (async () => {
          throw new Error(
            "This worker is not permitted to access the internet via global functions like fetch(). It must use capabilities (such as bindings in 'env') to talk to the outside world.",
          );
        }) as typeof fetch;
      module = await importCode(m, sink);
      exports = ctxExports(module, env);
      return Object.fromEntries(Object.entries(module).map(([k, v]) => [k, typeof v]));
    }
    if (m.type === "image") return await images.get(m.token)?.();
    if (m.type === "object") {
      const { rt, stub, key } = await facet(m.className, m.cellKey);
      if (m.op === "attach") {
        facetKeys.set(key, { key: m.cellKey, epoch: m.epoch });
        return;
      }
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
    if (m.type === "call") return exported(m.name, m.props)[m.method](...m.args);
    throw new Error(`unknown isolate message ${m.type}`);
  };
  const { call } = isolatePort(port, handle, fetchTarget);
}

const safe = (args: unknown[]) =>
  args.map((a) => {
    try {
      return structuredClone(a);
    } catch {
      return String(a);
    }
  });
