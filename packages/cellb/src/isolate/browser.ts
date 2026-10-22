import type { ModuleLoader, WorkerCode } from "../bindings/worker-loader.js";
import { isolatedModuleLoader } from "./host.js";
import type { PortLike } from "./protocol.js";

/**
 * Isolated loading in browsers: each loaded Worker runs in its own Dedicated Worker
 * (`isolateScript`, see browser/isolate/isolate-worker.ts). With `siteBaseUrl` (the in-browser
 * HTTP server of note 19) its modules are uploaded and imported from URLs; otherwise they
 * travel to the isolate and become Blob-URL modules there.
 */
export function browserIsolatedLoader(opts: {
  isolateScript: URL;
  siteBaseUrl?: string;
}): ModuleLoader {
  return isolatedModuleLoader({
    spawn: () => {
      const w = new Worker(opts.isolateScript, { type: "module" });
      return { port: w as unknown as PortLike, terminate: () => w.terminate() };
    },
    prepare: async (id: string, code: WorkerCode) => {
      if (!opts.siteBaseUrl) return { modules: code.modules, mainModule: code.mainModule } as never;
      const base = opts.siteBaseUrl.endsWith("/") ? opts.siteBaseUrl : `${opts.siteBaseUrl}/`;
      const dir = encodeURIComponent(`isolate-${id}`);
      for (const [name, m] of Object.entries(code.modules)) {
        const text =
          typeof m === "string"
            ? m
            : (m.js ?? m.esModule ?? `export default ${JSON.stringify(m.text ?? m.json)};`);
        await fetch(`${base}loaded-src/${dir}/${name}`, { method: "PUT", body: text });
      }
      return {
        url: `${base}loaded/${dir}/~/${code.mainModule}`,
        consoleId: `isolate-${id}`,
      } as never;
    },
  });
}
