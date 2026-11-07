/// <reference lib="webworker" />
// loadProject from @statewalker/cellb/browser: the URL of a `cellb build` folder and an OPFS
// name, nothing else (SQLite WASM and the isolate worker are the package's own). Or a project's
// sources in a FilesApi, with a compiler (#72): `bundle` (webrun-bundler on esbuild-wasm) or
// `site` (served by the page's ServiceWorker, which hosts it for this worker).

import { loadProject, type ProjectCompiler } from "@statewalker/cellb/browser";
import { bundleCompiler } from "@statewalker/cellb/bundle";
import { siteCompiler, siteHostOverPort } from "@statewalker/cellb/site";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import * as esbuild from "esbuild-wasm";
import wasmURL from "esbuild-wasm/esbuild.wasm?url";

const scope = self as unknown as DedicatedWorkerGlobalScope;

let esbuildReady: Promise<void> | undefined;
async function compiler(kind: "bundle" | "site"): Promise<ProjectCompiler> {
  if (kind === "site") return siteCompiler({ host: siteHostOverPort(scope) });
  esbuildReady ??= esbuild.initialize({ wasmURL, worker: false });
  await esbuildReady;
  return bundleCompiler({ esbuild });
}

async function sourceFiles(sources: [string, string][]) {
  const files = new MemFilesApi();
  for (const [path, b64] of sources)
    await files.write(path, [Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]);
  return files;
}

scope.addEventListener("message", async (e) => {
  if (!e.ports[0]) return; // not a job (the page's answers about sites)
  const reply = (v: unknown) => (e.ports[0] as MessagePort).postMessage(v);
  const { url, sources, compile, data, runs } = e.data as {
    url?: string;
    sources?: [string, string][];
    compile?: "bundle" | "site";
    data: string;
    runs: string[][];
  };
  try {
    const out: { status: number; type: string | null; body: string }[][] = [];
    let name = "";
    let unsupported: string[] = [];
    // Each run loads the project afresh (same `data`), then closes it.
    for (const paths of runs) {
      const project = sources
        ? await loadProject(await sourceFiles(sources), {
            data,
            compile: compile ? await compiler(compile) : undefined,
          })
        : await loadProject(url as string, { data });
      name = project.config.name ?? "";
      unsupported = project.unsupported;
      const responses = [];
      for (const path of paths) {
        const res = await project.fetch(new Request(`http://localhost${path}`));
        responses.push({
          status: res.status,
          type: res.headers.get("content-type"),
          body: await res.text(),
        });
      }
      await project.close();
      out.push(responses);
    }
    reply({ ok: true, name, unsupported, out });
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
});
