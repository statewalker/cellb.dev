/**
 * Astro's compiler as WebAssembly: the wasm32-wasi build of `@astrojs/compiler-rs`
 * (`@astrojs/compiler-binding-wasm32-wasi`), instantiated with `@napi-rs/wasm-runtime`. Its
 * module is built with threads, so it imports a SHARED memory: workerd, celld and cellb on Node
 * provide one; a browser realm must be cross-origin isolated (COOP/COEP).
 *
 * Ported from cellb.dev's examples/astro-in-browser (browser/compiler.ts), which fetched the
 * module from npm and compiled it from bytes: here the caller passes it (a `WebAssembly.Module`
 * imported by the entry where the host forbids compiling from bytes, or bytes where it allows).
 */
import { getDefaultContext, instantiateNapiModuleSync, WASI } from "@napi-rs/wasm-runtime";
import type { AstroTransform } from "./astro-plugin.js";

/** The binding of @astrojs/compiler-rs 0.5.3, which astro 7.4.11 installs. */
export const ASTRO_COMPILER_BINDING = {
  name: "@astrojs/compiler-binding-wasm32-wasi",
  version: "0.5.3",
};

export function loadAstroCompiler(wasm: WebAssembly.Module | BufferSource): AstroTransform {
  let memory: WebAssembly.Memory;
  try {
    // The module declares 981 pages (61 MB) at least: start there and let it grow.
    memory = new WebAssembly.Memory({ initial: 1024, maximum: 65536, shared: true });
  } catch (e) {
    throw new Error(
      `Astro's compiler needs a shared WebAssembly memory, which this realm refuses (a browser page must be cross-origin isolated): ${(e as Error).message}`,
    );
  }
  const { napiModule } = instantiateNapiModuleSync(
    wasm as never,
    {
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
    } as never,
  );
  const binding = napiModule.exports as {
    compileAstroSync(source: string, options: Record<string, unknown>): ReturnType<AstroTransform>;
  };
  // The options as @astrojs/compiler-rs maps them (`mapOptions`), and its `transform`'s own
  // step after the binding: `resolvePath` resolves each component's specifier, and the islands'
  // `client:component-path` in the code are rewritten to it. Without it a project's own island
  // (`../components/Counter.tsx`) cannot be found at render ("Unable to resolve").
  return (source, o) => {
    const r = compile(source, o);
    const resolve = o.resolvePath as ((specifier: string) => string) | undefined;
    if (typeof resolve === "function") {
      const all = [
        ...(r.hydratedComponents ?? []),
        ...(r.clientOnlyComponents ?? []),
        ...((r as { serverComponents?: typeof r.hydratedComponents }).serverComponents ?? []),
      ];
      for (const c of all) c.resolvedPath = resolve(c.specifier);
      let code = r.code;
      for (const c of all)
        if (c.resolvedPath && c.resolvedPath !== c.specifier)
          code = code
            .split(`"client:component-path": "${c.specifier}"`)
            .join(`"client:component-path": "${c.resolvedPath}"`);
      r.code = code;
    }
    return r;
  };
  function compile(source: string, o: Record<string, unknown>) {
    return binding.compileAstroSync(source, {
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
}

let fromStore: Promise<AstroTransform> | undefined;

/**
 * Astro's compiler for this realm, its WebAssembly fetched from the npm registry (through
 * `fetchImpl`: the platform's package store) and compiled here. Only realms that can compile from
 * bytes build Astro in their own realm (cellb, browsers); workerd and celld build in a Worker
 * Loader isolate (./loader.ts), so the platform does not carry the compiler.
 */
export function astroCompilerFromRegistry(fetchImpl?: typeof fetch): Promise<AstroTransform> {
  fromStore ??= (async () => {
    const { npmRegistrySource } = await import("@statewalker/webrun-modules");
    const { readFile } = await import("@statewalker/webrun-files");
    const pkg = await npmRegistrySource({ fetch: fetchImpl }).load({
      pkg: ASTRO_COMPILER_BINDING.name,
      version: ASTRO_COMPILER_BINDING.version,
    });
    const bytes = await readFile(pkg.files, "/astro.wasm32-wasi.wasm");
    return loadAstroCompiler(await WebAssembly.compile(bytes as BufferSource));
  })();
  return fromStore;
}
