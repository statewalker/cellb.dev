/// <reference lib="webworker" />
// The editor's TypeScript language service: TypeScript 6 (the last JavaScript compiler; 7 is
// native) over an in-memory file system, in a Worker of its own. Two environments, as the project
// has two runtimes: the client's files see the DOM, the server's see Cloudflare's Workers types
// (with `cloudflare:workers`). The libraries come from jsdelivr, npm packages' types too (automatic
// type acquisition from the files' imports). The editor (CodeEditor.tsx) talks to it with Comlink,
// in the shape @valtown/codemirror-ts expects: getLints, getAutocompletion, getHover, updateFile.

import type { CompletionContext } from "@codemirror/autocomplete";
import { setupTypeAcquisition } from "@typescript/ata";
import {
  createDefaultMapFromCDN,
  createSystem,
  createVirtualTypeScriptEnvironment,
  type VirtualTypeScriptEnvironment,
} from "@typescript/vfs";
import { getAutocompletion, getHover, getLints } from "@valtown/codemirror-ts/worker";
import * as Comlink from "comlink";
import ts from "typescript-js";

const VERSION = ts.version;
// @typescript/vfs's and @typescript/ata's typings name the workspace's "typescript" (7, native):
// the module handed to them at runtime is 6, whose API they use.
const tsApi = ts as never;
const CDN = `https://cdn.jsdelivr.net/npm/typescript@${VERSION}/`;
const WORKERS_TYPES = "https://cdn.jsdelivr.net/npm/@cloudflare/workers-types@4/index.d.ts";
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;

const base: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  skipLibCheck: true,
  allowJs: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  esModuleInterop: true,
};

// The libraries, fetched from jsdelivr rather than the playground's CDN @typescript/vfs names.
const fetcher = (url: string) =>
  fetch(
    url.replace(/^https:\/\/playgroundcdn\.typescriptlang\.org\/cdn\/[^/]+\/typescript\//, CDN),
  );

let envs:
  | Promise<{ client: VirtualTypeScriptEnvironment; server: VirtualTypeScriptEnvironment }>
  | undefined;
/** The project the environments hold, and where its two runtimes' files are. */
let project = {
  key: "",
  clientRoot: undefined as string | undefined,
  serverRoot: undefined as string | undefined,
};
const synced = new Set<string>();

// The libraries are fetched once per lib set, for every project the tab opens.
const libCache = new Map<string, Promise<Map<string, string>>>();
const libs = (lib: string[]) => {
  const key = lib.join(",");
  let m = libCache.get(key);
  if (!m) {
    m = createDefaultMapFromCDN(
      { ...base, lib },
      VERSION,
      false,
      tsApi,
      undefined,
      fetcher as never,
    );
    m.catch(() => libCache.delete(key));
    libCache.set(key, m);
  }
  return m;
};
let workersTypes: Promise<string> | undefined;

async function environment(lib: string[], extra: Map<string, string>, options: ts.CompilerOptions) {
  const fsMap = new Map(await libs(lib));
  for (const [p, t] of extra) fsMap.set(p, t);
  return createVirtualTypeScriptEnvironment(createSystem(fsMap), [], tsApi, {
    ...base,
    ...options,
    lib,
  });
}

function start() {
  envs ??= (async () => {
    workersTypes ??= fetch(WORKERS_TYPES)
      .then((r) => (r.ok ? r.text() : ""))
      .catch(() => "");
    const workers = await workersTypes;
    const [client, server] = await Promise.all([
      environment(["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"], new Map(), {}),
      environment(
        ["lib.es2022.d.ts"],
        new Map([["/node_modules/@cloudflare/workers-types/index.d.ts", workers]]),
        { types: ["@cloudflare/workers-types"] },
      ),
    ]);
    return { client, server };
  })();
  envs.catch(() => {
    envs = undefined;
  });
  return envs;
}

const under = (path: string, root?: string) =>
  root !== undefined && (root === "/" || path === root || path.startsWith(`${root}/`));

/**
 * Which runtime a file belongs to: the server's folder (the Wrangler `main`'s) is the server's;
 * a client folder ("/" for a site at the root) is the client's; a project without a server is
 * all client; anything else is the server's.
 */
const envOf = async (path: string) => {
  const { client, server } = await start();
  const { clientRoot, serverRoot } = project;
  if (serverRoot && serverRoot !== "/" && under(path, serverRoot)) return server;
  if (under(path, clientRoot) || !serverRoot) return client;
  return server;
};

// Editors to tell when types arrive: their diagnostics were computed without them.
const onTypes = new Map<number, () => void>();
let nextListener = 0;
const ataSoon = new Map<string, ReturnType<typeof setTimeout>>();
let typesQuiet: ReturnType<typeof setTimeout> | undefined;
const typesArrived = () => {
  clearTimeout(typesQuiet);
  typesQuiet = setTimeout(() => {
    for (const [id, notify] of onTypes) Promise.resolve(notify()).catch(() => onTypes.delete(id));
  }, 200);
};

// Types of npm packages, from the imports of the files the service sees (both environments).
const ata = setupTypeAcquisition({
  projectName: "cellb-sandbox",
  typescript: tsApi,
  logger: { log: () => {}, error: () => {}, groupCollapsed: () => {}, groupEnd: () => {} } as never,
  delegate: {
    started: () => console.info("[ts] fetching types for the imports"),
    finished: (files: Map<string, string>) => console.info(`[ts] types: ${files.size} files`),
    errorMessage: (message: string) => console.warn(`[ts] types: ${message}`),
    receivedFile: (code: string, path: string) => {
      void start().then(({ client, server }) => {
        for (const env of [client, server]) upsert(env, path, code);
        typesArrived();
      });
    },
  },
});

function upsert(env: VirtualTypeScriptEnvironment, path: string, code: string) {
  if (env.getSourceFile(path)) env.updateFile(path, code || " ");
  else env.createFile(path, code || " ");
}

const api = {
  async initialize() {
    await start();
  },
  /**
   * The project's script files and where its runtimes are: what the service checks against. A
   * different project starts from fresh environments (the libraries are kept); a file gone since
   * the last call is emptied.
   */
  async syncProject(
    files: [string, string][],
    where: { key: string; clientRoot?: string; serverRoot?: string },
  ) {
    if (where.key !== project.key) {
      envs = undefined;
      synced.clear();
    }
    project = { key: where.key, clientRoot: where.clientRoot, serverRoot: where.serverRoot };
    const now = new Set<string>();
    for (const [path, code] of files) {
      if (!SCRIPT.test(path)) continue;
      now.add(path);
      upsert(await envOf(path), path, code);
      ata(code);
    }
    for (const path of synced) if (!now.has(path)) upsert(await envOf(path), path, " ");
    synced.clear();
    for (const p of now) synced.add(p);
  },
  async updateFile({ path, code }: { path: string; code: string }) {
    upsert(await envOf(path), path, code);
    synced.add(path);
    // Types for the imports, once typing pauses: not one registry lookup per keystroke.
    clearTimeout(ataSoon.get(path));
    ataSoon.set(
      path,
      setTimeout(() => {
        ataSoon.delete(path);
        ata(code);
      }, 1500),
    );
  },
  async getLints({
    path,
    diagnosticCodesToIgnore,
  }: {
    path: string;
    diagnosticCodesToIgnore: number[];
  }) {
    return getLints({ env: await envOf(path), path, diagnosticCodesToIgnore });
  },
  async getAutocompletion({
    path,
    context,
  }: {
    path: string;
    context: Pick<CompletionContext, "pos" | "explicit">;
  }) {
    return getAutocompletion({ env: await envOf(path), path, context });
  },
  /** Called (through Comlink.proxy) whenever acquired types arrive: the editor lints again. */
  onTypes(notify: () => void): number {
    const id = ++nextListener;
    onTypes.set(id, notify);
    return id;
  },
  /** An editor closed: no more calls to it. */
  offTypes(id: number) {
    onTypes.delete(id);
  },
  async getHover({ path, pos }: { path: string; pos: number }) {
    return getHover({ env: await envOf(path), path, pos });
  },
};

export type TsWorker = typeof api;
Comlink.expose(api);
