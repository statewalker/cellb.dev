/**
 * Resolution the bundler's own plugin does not do, ahead of it:
 * - `/node_modules/<name>/<path>`: files of a package by path, as integrations name their
 *   routes and middleware (`createRequire().resolve()` over the build-time VFS);
 * - `/app/<path>` (the build-time VFS's project root) and `/src/…`: project files;
 * - imports from Vite plugins' modules (namespace `vite-virtual`): from the project's root;
 * - `.css` files: collected (relative `@import`s inlined) as the importing module's styles.
 */
import type { Mount, PackageStore } from "@statewalker/webrun-bundler";
import type { Plugin } from "esbuild-wasm";
import type { CompiledComponent } from "./astro-plugin.js";

const pkgOf = (spec: string) => {
  const parts = spec.split("/");
  const n = spec.startsWith("@") ? 2 : 1;
  return { name: parts.slice(0, n).join("/"), sub: parts.slice(n).join("/") };
};

async function readText(m: Mount, id: string): Promise<string> {
  const path = `${m.root.replace(/\/$/, "")}${id.slice(m.prefix.length)}`;
  const chunks: Uint8Array[] = [];
  for await (const c of m.files.read(path)) chunks.push(c);
  return new TextDecoder().decode(new Uint8Array(chunks.flatMap((c) => [...c])));
}

const BUILTINS = new Set([
  "fs",
  "path",
  "url",
  "os",
  "crypto",
  "util",
  "events",
  "buffer",
  "stream",
  "module",
  "process",
  "assert",
  "async_hooks",
  "tty",
  "zlib",
  "http",
  "https",
  "net",
  "child_process",
  "worker_threads",
  "fs/promises",
  "perf_hooks",
]);

/** Client files the build emits (`?url` imports), by URL path. */
export type ClientAssets = Map<string, Uint8Array>;

export function pathsPlugin(opts: {
  root: string;
  packages: PackageStore;
  nodeMounts: Map<string, Mount>;
  mounts: Map<string, Mount>;
  components: Map<string, CompiledComponent>;
  clientAssets: ClientAssets;
  /** Sources for bare Node built-in names (`fs`): the runtime's `node:` module, if any. */
  builtin: (name: string) => string | undefined;
  trace?: import("./trace.js").Trace;
}): Plugin {
  const project = opts.mounts.get("~") as Mount;
  const mountOf = async (name: string) => {
    const known = opts.nodeMounts.get(name);
    if (known) return known;
    const m = await opts.packages.get(name, { mount: project, path: `${opts.root}/package.json` });
    if (m) opts.mounts.set(m.prefix, m);
    return m;
  };
  const locate = (id: string) => {
    let best: Mount | undefined;
    for (const m of opts.mounts.values())
      if (id.startsWith(`${m.prefix}/`) && (!best || m.prefix.length > best.prefix.length))
        best = m;
    return best;
  };
  const registered = new Set<string>();
  return {
    name: "astro-paths",
    setup(b) {
      for (const m of opts.nodeMounts.values()) opts.mounts.set(m.prefix, m);
      b.onResolve({ filter: /^\/node_modules\// }, async (args) => {
        const { name, sub } = pkgOf(args.path.slice("/node_modules/".length));
        const m = await mountOf(name);
        if (!m) return { errors: [{ text: `no package ${name} for ${args.path}` }] };
        // The bundler reads only from packages it resolved itself: resolve the package once.
        if (!registered.has(name)) {
          registered.add(name);
          for (const spec of [name, `${name}/package.json`]) {
            const r = await b.resolve(spec, {
              kind: "import-statement",
              importer: "~/package.json",
              namespace: "webrun",
              resolveDir: "/",
            });
            if (!r.errors.length) break;
          }
        }
        opts.trace?.add("resolve", `${args.path} -> ${m.prefix}/${sub}`, {
          via: "package path",
          importer: args.importer,
        });
        return { path: `${m.prefix}/${sub}`, namespace: "webrun" };
      });
      // Bare built-in names (a package whose browser field would have dropped them).
      b.onResolve({ filter: /^[a-z_/]+$/ }, (args) =>
        BUILTINS.has(args.path)
          ? (opts.trace?.add("resolve", `${args.path} -> node:${args.path}`, {
              via: "bare built-in",
              importer: args.importer,
            }),
            { path: args.path, namespace: "builtin" })
          : undefined,
      );
      b.onLoad({ filter: /.*/, namespace: "builtin" }, (args) => ({
        contents: opts.builtin(args.path) ?? "export default {};",
        loader: "js",
      }));
      // `?url`: the file becomes a client asset under /_astro/, the module its URL.
      b.onResolve({ filter: /\?url$/ }, async (args) => {
        const r = await b.resolve(args.path.slice(0, -4), {
          kind: args.kind,
          importer: args.importer,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
        });
        if (r.errors.length) return { errors: r.errors };
        return { path: r.path, namespace: "url-asset" };
      });
      b.onLoad({ filter: /.*/, namespace: "url-asset" }, async (args) => {
        const m = locate(args.path);
        if (!m) return { errors: [{ text: `no tree for ${args.path}` }] };
        const bytes = new TextEncoder().encode(await readText(m, args.path));
        const name = args.path.split("/").pop() as string;
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))]
          .slice(0, 4)
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("");
        const url = `/_astro/${name.replace(/(\.[^.]+)$/, `.${hash}$1`)}`;
        opts.clientAssets.set(url, bytes);
        opts.trace?.add("transform", `?url ${args.path} -> ${url}`, { bytes: bytes.length });
        return { contents: `export default ${JSON.stringify(url)};`, loader: "js" };
      });
      // A package's `#imports` that name `.js` for TypeScript sources (`#settings/index.js`).
      b.onResolve({ filter: /^#/ }, async (args) => {
        const m = locate(args.importer);
        const imports = (m?.manifest as { imports?: Record<string, string> } | undefined)?.imports;
        if (!m || !imports) return undefined;
        for (const [key, target] of Object.entries(imports)) {
          if (typeof target !== "string") continue;
          const star = key.indexOf("*");
          const hit =
            star < 0
              ? key === args.path
                ? ""
                : undefined
              : args.path.startsWith(key.slice(0, star)) && args.path.endsWith(key.slice(star + 1))
                ? args.path.slice(star, args.path.length - (key.length - star - 1))
                : undefined;
          if (hit === undefined) continue;
          const rel = target.replace("*", hit).replace(/^\.\//, "");
          for (const cand of [
            rel,
            rel.replace(/\.js$/, ".ts"),
            rel.replace(/\.js$/, ".tsx"),
            rel.replace(/\.js$/, "/index.ts"),
          ]) {
            const path = `${m.root.replace(/\/$/, "")}/${cand}`;
            if (await m.files.stats(path)) {
              opts.trace?.add("resolve", `${args.path} -> ${m.prefix}/${cand}`, {
                via: "#imports",
                importer: args.importer,
              });
              return { path: `${m.prefix}/${cand}`, namespace: "webrun" };
            }
          }
        }
        return undefined;
      });
      // File ids (islands' specifiers, as the compiler's resolver wrote them).
      b.onResolve({ filter: /^(npm:|~\/)/ }, async (args) => {
        // The bundler resolves imports from a file only in packages it resolved itself.
        const m = /^npm:((?:@[^/@]+\/)?[^/@]+)@/.exec(args.path);
        if (m && !registered.has(m[1])) {
          registered.add(m[1]);
          for (const spec of [m[1], `${m[1]}/package.json`]) {
            const r = await b.resolve(spec, {
              kind: "import-statement",
              importer: "~/package.json",
              namespace: "webrun",
              resolveDir: "/",
            });
            if (!r.errors.length) break;
          }
        }
        return { path: args.path, namespace: "webrun" };
      });
      b.onResolve({ filter: /^\/app\// }, (args) => ({
        path: `~${args.path.slice(4)}`,
        namespace: "webrun",
      }));
      b.onResolve({ filter: /^\/src\// }, (args) => ({
        path: `~${args.path}`,
        namespace: "webrun",
      }));
      b.onResolve({ filter: /.*/ }, async (args) => {
        if (args.namespace !== "vite-virtual" || args.pluginData?.fromVite) return undefined;
        return b.resolve(args.path, {
          kind: args.kind,
          importer: "~/package.json",
          namespace: "webrun",
          resolveDir: "/",
          pluginData: { fromVite: true },
        });
      });
      b.onLoad({ filter: /\.css$/, namespace: "webrun" }, async (args) => {
        const m = locate(args.path);
        if (!m) return undefined;
        const seen = new Set<string>();
        const inline = async (id: string): Promise<string> => {
          if (seen.has(id)) return "";
          seen.add(id);
          const text = await readText(m, id).catch(() => "");
          const dir = id.slice(0, id.lastIndexOf("/"));
          let out = "";
          let rest = text;
          for (const im of text.matchAll(/@import\s+(?:url\()?["']([^"']+)["']\)?[^;]*;/g)) {
            if (/^(https?:|\/\/)/.test(im[1])) continue;
            const target = new URL(im[1], `file://${dir}/`).pathname;
            out += await inline(
              target.startsWith(m.prefix) ? target : `${dir}/${im[1]}`.replace(/\/\.\//g, "/"),
            );
            rest = rest.replace(im[0], "");
          }
          return out + rest;
        };
        const css = await inline(args.path);
        opts.components.set(args.path, { css: [css], containsHead: false, propagation: false });
        opts.trace?.add("transform", `css ${args.path}`, {
          bytes: css.length,
          imports: seen.size - 1,
        });
        return { contents: "", loader: "js" };
      });
    },
  };
}
