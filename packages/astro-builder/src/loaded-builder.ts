/**
 * The Astro builder as a Worker of its own, for hosts whose realms cannot evaluate code
 * (workerd and celld refuse `import("data:…")`, `new Function` and Blob URLs): the bundler's
 * object loads it through its Worker Loader binding with the project's bundled config among its
 * modules, so the config and its integrations (the project's own code, and npm packages) run in
 * an isolate of their own, statically imported, never evaluated from a string.
 *
 *   modules: builder.js (this file, bundled by scripts/build.mjs), config.js (the bundled
 *            astro.config.mjs), esbuild.wasm, astro.wasm (Astro's compiler)
 *   POST /   body: the project as a ZIP; header x-astro-spec: the AstroSpec
 *            → the output (wrangler.json, server/entry.mjs, client/…) as a ZIP, with the build's
 *              log in /.astro-log.json
 */

import { projectPeers } from "@statewalker/cellb-platform-core/peers";
import { unzip, zip } from "@statewalker/cellb-platform-core/util";
import { npmPackages } from "@statewalker/webrun-bundler";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { npmRegistrySource } from "@statewalker/webrun-modules";
import * as esbuild from "esbuild-wasm/esm/browser.js";
// A module of the loaded Worker (`*.wasm` modules are declared in src/types.d.ts).
import astroWasm from "./astro.wasm";
import type { AstroTransform } from "./astro-plugin.js";
import { loadAstroCompiler } from "./compiler.js";
import esbuildWasm from "./esbuild.wasm";
import { type AstroSpec, buildAstroProject } from "./project.js";

let ready: Promise<AstroTransform> | undefined;

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      ready ??= (async () => {
        (globalThis as { self?: unknown }).self ??= globalThis;
        await esbuild.initialize({ wasmModule: esbuildWasm, worker: false });
        return loadAstroCompiler(astroWasm);
      })();
      const transform = await ready;
      const spec = JSON.parse(request.headers.get("x-astro-spec") ?? "{}") as AstroSpec;
      const files = new MemFilesApi();
      for (const [p, b] of await unzip(new Uint8Array(await request.arrayBuffer())))
        await files.write(p, [b]);
      const log: string[] = [];
      const packages = await projectPeers(
        npmPackages({ source: npmRegistrySource() as never }),
        files,
      );
      const out = await buildAstroProject({
        files,
        esbuild,
        transform,
        packages,
        spec,
        log: (m) => log.push(m),
        // @ts-expect-error: a module of the loaded Worker, not a file of this package
        configModule: () => import("./config.js"),
      });
      out.files.set(
        "/.astro-log.json",
        new TextEncoder().encode(JSON.stringify({ log, routes: out.routes, ms: out.ms })),
      );
      return new Response(zip([...out.files]) as BodyInit, {
        headers: { "content-type": "application/zip" },
      });
    } catch (e) {
      return new Response(String((e as Error)?.stack ?? e), { status: 500 });
    }
  },
};
