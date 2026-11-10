/**
 * Astro's compiler in a browser: the wasm build of `@astrojs/compiler-rs`
 * (`@astrojs/compiler-binding-wasm32-wasi`), fetched from the npm registry like every other
 * package and instantiated with `@napi-rs/wasm-runtime`. Its module is built with threads, so
 * it imports a SHARED memory: the realm must be cross-origin isolated (COOP/COEP).
 */
import { getDefaultContext, instantiateNapiModuleSync, WASI } from "@napi-rs/wasm-runtime";
import { npmRegistrySource } from "@statewalker/webrun-modules";
import type { AstroTransform } from "../src/builder/astro-plugin.ts";

const BINDING = "@astrojs/compiler-binding-wasm32-wasi";
const VERSION = "0.5.2"; // the binding of @astrojs/compiler-rs 0.5.2, which astro 7.4.4 uses

async function readBytes(files: { read(p: string): AsyncIterable<Uint8Array> }, path: string) {
  const chunks: Uint8Array[] = [];
  for await (const c of files.read(path)) chunks.push(c);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) out.set(c, at), (at += c.length);
  return out;
}

export async function loadAstroCompiler(): Promise<AstroTransform> {
  if (!globalThis.crossOriginIsolated)
    throw new Error("Astro's compiler needs a cross-origin isolated realm (COOP/COEP headers)");
  const pkg = await npmRegistrySource().load({ pkg: BINDING, version: VERSION });
  const wasm = await readBytes(pkg.files, "/astro.wasm32-wasi.wasm");
  // The module declares 981 pages (61 MB) at least: start there and let it grow (it was 4000
  // pages, 256 MB reserved before any compilation).
  const memory = new WebAssembly.Memory({ initial: 1024, maximum: 65536, shared: true });
  const { napiModule } = instantiateNapiModuleSync(wasm, {
    context: getDefaultContext(),
    asyncWorkPoolSize: 0, // only compileAstroSync is used: no thread pool
    wasi: new WASI({ version: "preview1" }),
    overwriteImports(importObject: Record<string, Record<string, unknown>>) {
      importObject.env = {
        ...importObject.env,
        ...importObject.napi,
        ...importObject.emnapi,
        memory,
      };
      return importObject;
    },
    beforeInit({ instance }: { instance: WebAssembly.Instance }) {
      for (const name of Object.keys(instance.exports))
        if (name.startsWith("__napi_register__")) (instance.exports[name] as () => void)();
    },
  } as never);
  const binding = napiModule.exports as {
    compileAstroSync(source: string, options: Record<string, unknown>): ReturnType<AstroTransform>;
  };
  // The options as @astrojs/compiler-rs maps them (`mapOptions`).
  return (source, o) =>
    binding.compileAstroSync(source, {
      filename: o.filename,
      normalizedFilename: o.normalizedFilename,
      internalURL: o.internalURL,
      sourcemap: o.sourcemap,
      astroGlobalArgs: o.astroGlobalArgs,
      compact: o.compact === true ? "html" : o.compact === "jsx" ? "jsx" : "none",
      resultScopedSlot: o.resultScopedSlot,
      scopedStyleStrategy: o.scopedStyleStrategy,
      transitionsAnimationURL: o.transitionsAnimationURL,
      resolvePathProvided: typeof o.resolvePath === "function" || undefined,
    });
}
