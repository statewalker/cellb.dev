// The project's notebooks: Markdown files (fenced `js` blocks are reactive cells, `npm:` imports,
// `display()`) or Observable Notebook Kit `.html` documents in `notebooks/`, served at
// `notebooks/` next to the app, so a cell can `fetch("../api/…")` the project's own Worker:
// dashboards over its Durable Objects, notes, reports an agent writes.
//
// Built by @statewalker/notebook-build in hosted mode (linkedom as its DOM, so it runs in the
// runner worker), on the first request: the pages import notebook-kit's runtime and their npm
// modules from absolute URLs under the site's own path, which is known once the site is hosted.
// Served by @statewalker/notebook-site; modules by a webrun-modules server whose cache lives as
// long as the runner (a rerun downloads nothing again).

import { newNotebookBuild } from "@statewalker/notebook-build";
import { newNotebookSite } from "@statewalker/notebook-site";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newModuleServer } from "@statewalker/webrun-modules";
import { DOMParser, parseHTML } from "linkedom";
import type { ProjectFiles } from "./project";

export const NOTEBOOKS_DIR = "/notebooks";
const MODULES = "/_m/";

export interface NotebookSiteOptions {
  /** The notebooks' files, rooted at "/" (notebooks/index.md → /index.md). */
  files: ProjectFiles;
  /** The site's path in the browser ("/<id>/"), known once it is hosted. */
  sitePath: () => string;
  /** The module server's cache (one per runner). */
  cache: FilesApi;
  log: (text: string, level?: "info" | "error") => void;
}

/** A handler for requests below `notebooks/` (paths relative to it: "/index.html", "/_m/…"). */
export function createNotebookSite(opts: NotebookSiteOptions) {
  let ready:
    | Promise<{
        site: (r: Request) => Promise<Response>;
        modules: (r: Request) => Promise<Response>;
        base: string;
      }>
    | undefined;
  const build = async () => {
    const t0 = performance.now();
    const base = `${opts.sitePath().replace(/\/?$/, "/")}notebooks${MODULES}`;
    const moduleServer = newModuleServer({ cache: opts.cache, basePath: base, target: "browser" });
    const styles = await moduleServer.resolve({
      pkg: "@observablehq/notebook-kit",
      subpath: "dist/src/styles/index.css",
    });
    // webrun-modules 0.3 repeats a subpath in a resolved URL (…/dist/src/styles/dist/src/styles/…).
    const subpath = "dist/src/styles/";
    const stylesUrl = styles.url.replace(`/${subpath}${subpath}`, `/${subpath}`);
    const notebooks = new MemFilesApi();
    for (const [path, bytes] of opts.files) await notebooks.write(path, [bytes]);
    const output = new MemFilesApi();
    const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
    let failed = 0;
    await newNotebookBuild({
      notebooks,
      output,
      cache: new MemFilesApi(),
      moduleServer,
      dom: { document, parser: new DOMParser() },
      mode: "hosted",
      basePath: base,
      stylesUrl,
      onFailed: (f: unknown) => {
        for (const x of (Array.isArray(f) ? f : [f]) as {
          notebookPath: string;
          error: unknown;
        }[]) {
          failed++;
          opts.log(
            `notebooks: ${x.notebookPath}: ${String((x.error as Error)?.message ?? x.error)}`,
            "error",
          );
        }
      },
    } as never).build();
    const pages = (await listPaths(output)).filter((p) => p.endsWith(".html"));
    opts.log(
      `notebooks: ${pages.length} page(s) built in ${Math.round(performance.now() - t0)} ms${failed ? `, ${failed} failed` : ""}`,
    );
    return {
      site: newNotebookSite({ output, basePath: MODULES } as never) as (
        r: Request,
      ) => Promise<Response>,
      modules: (r: Request) => moduleServer.fetch(r),
      base,
    };
  };
  return async (request: Request, path: string): Promise<Response> => {
    ready ??= build().catch((err) => {
      ready = undefined;
      throw err;
    });
    const { site, modules, base } = await ready;
    const url = new URL(request.url);
    if (path.startsWith(MODULES))
      return modules(
        new Request(new URL(`${base}${path.slice(MODULES.length)}${url.search}`, url), request),
      );
    return site(
      new Request(new URL(`${path === "/" ? "/index.html" : path}${url.search}`, url), request),
    );
  };
}

async function listPaths(fs: FilesApi): Promise<string[]> {
  const out: string[] = [];
  for await (const e of fs.list("/", { recursive: true })) if (e.kind === "file") out.push(e.path);
  return out;
}

/** The notebooks' files of a project, rooted at "/" (undefined when it has none). */
export function notebookFilesOf(files: ProjectFiles): ProjectFiles | undefined {
  const out: ProjectFiles = new Map();
  for (const [path, bytes] of files)
    if (path.startsWith(`${NOTEBOOKS_DIR}/`)) out.set(path.slice(NOTEBOOKS_DIR.length), bytes);
  return [...out.keys()].some((p) => /\.(md|html)$/i.test(p)) ? out : undefined;
}

/**
 * The notebooks as static files for a deployment served at the origin's root: pages under
 * `/notebooks/`, and (notebook-build's static mode) every module they reach, with the CSS, wasm
 * and fonts their packages ship, under `/notebooks/_m/`. Paths as a static host serves them.
 */
export async function exportNotebooks(
  files: ProjectFiles,
  cache: FilesApi,
  log: (text: string, level?: "info" | "error") => void,
): Promise<ProjectFiles> {
  const base = `${NOTEBOOKS_DIR}${MODULES}`;
  const moduleServer = newModuleServer({ cache, basePath: base, target: "browser" });
  const styles = await moduleServer.resolve({
    pkg: "@observablehq/notebook-kit",
    subpath: "dist/src/styles/index.css",
  });
  const subpath = "dist/src/styles/";
  const stylesUrl = styles.url.replace(`/${subpath}${subpath}`, `/${subpath}`);
  const notebooks = new MemFilesApi();
  for (const [path, bytes] of files) await notebooks.write(path, [bytes]);
  const output = new MemFilesApi();
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  let failed = 0;
  await newNotebookBuild({
    notebooks,
    output,
    cache: new MemFilesApi(),
    moduleServer,
    dom: { document, parser: new DOMParser() },
    mode: "static",
    basePath: base,
    stylesUrl,
    onFailed: (f: unknown) => {
      for (const x of (Array.isArray(f) ? f : [f]) as { notebookPath: string; error: unknown }[]) {
        failed++;
        log(
          `build: notebooks: ${x.notebookPath}: ${String((x.error as Error)?.message ?? x.error)}`,
          "error",
        );
      }
    },
  } as never).build();
  if (failed) throw new Error(`${failed} notebook(s) did not build`);
  // The stylesheet the pages link: the static closure follows scripts, so make sure it is there.
  const out: ProjectFiles = new Map();
  for (const path of await listPaths(output)) {
    const chunks: Uint8Array[] = [];
    for await (const c of output.read(path)) chunks.push(c);
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    // Pages are written at the notebooks' own paths; the closure under the base path already.
    out.set(path.startsWith(base) ? path : `${NOTEBOOKS_DIR}${path}`, bytes);
  }
  const stylesPath = new URL(stylesUrl, "http://x").pathname;
  if (!out.has(stylesPath)) {
    const res = await moduleServer.fetch(new Request(`http://x${stylesPath}`));
    if (res.ok) out.set(stylesPath, new Uint8Array(await res.arrayBuffer()));
  }
  const pages = [...out.keys()].filter((p) => p.endsWith(".html")).length;
  log(`build: notebooks: ${pages} page(s), ${out.size - pages} module and asset file(s)`);
  return out;
}
