/**
 * Vite plugins inside esbuild: the `resolveId` and `load` hooks of the plugins integrations
 * register (EmDash's `emdash-virtual-modules`, for one), for the specifiers they claim.
 */
import type { Plugin } from "esbuild-wasm";
import type { VitePluginLike } from "./integrations.js";

type Hook =
  | ((...a: unknown[]) => unknown)
  | { handler: (...a: unknown[]) => unknown; filter?: { id?: RegExp } };
const call = (hook: unknown, ctx: unknown, ...args: unknown[]) => {
  const h = hook as Hook | undefined;
  if (!h) return undefined;
  if (typeof h === "function") return h.apply(ctx, args);
  const f = h.filter?.id;
  if (f instanceof RegExp && typeof args[0] === "string" && !f.test(args[0])) return undefined;
  return h.handler.apply(ctx, args);
};

export function vitePluginsAdapter(
  plugins: VitePluginLike[],
  trace?: import("./trace.js").Trace,
): Plugin {
  const owner = new Map<string, VitePluginLike>();
  const ctx = {
    environment: {
      name: "ssr",
      config: { command: "build", consumer: "server", isProduction: true },
    },
    meta: { watchMode: false },
    resolve: async (id: string) => ({ id }),
    error: (e: unknown) => {
      throw e instanceof Error ? e : new Error(String(e));
    },
    warn() {},
    addWatchFile() {},
    emitFile: () => "",
  };
  return {
    name: "vite-plugins",
    setup(b) {
      b.onResolve({ filter: /^(virtual:|\0)/ }, async (args) => {
        for (const p of plugins) {
          const r = await call(p.resolveId, ctx, args.path, args.importer, { ssr: true });
          const id = typeof r === "string" ? r : (r as { id?: string } | null)?.id;
          if (id) {
            if (!owner.has(id))
              trace?.add("virtual", `resolve ${args.path} -> ${JSON.stringify(id)}`, {
                plugin: p.name,
                importer: args.importer,
              });
            owner.set(id, p);
            return { path: id, namespace: "vite-virtual" };
          }
        }
        return undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "vite-virtual" }, async (args) => {
        const p = owner.get(args.path);
        const t0 = performance.now();
        const r = p && (await call(p.load, ctx, args.path, { ssr: true }));
        const code = typeof r === "string" ? r : (r as { code?: string } | null)?.code;
        trace?.add(
          "virtual",
          `load ${JSON.stringify(args.path)}`,
          { plugin: p?.name, bytes: code?.length, head: code?.slice(0, 300) },
          performance.now() - t0,
        );
        if (code === undefined) return { errors: [{ text: `no plugin loads ${args.path}` }] };
        return { contents: code, loader: "ts", resolveDir: "/" };
      });
    },
  };
}
