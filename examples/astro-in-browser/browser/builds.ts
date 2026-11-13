/**
 * Saved builds: each app's last build (the Worker bundle and its client assets), kept in this
 * origin's private file system (OPFS) until the app is built again. The host pages run a saved
 * build instead of compiling (`?rebuild` compiles again), and the chooser (start.html) lists
 * them.
 *
 *   cellb-builds/<app>/worker.js     the bundle
 *   cellb-builds/<app>/assets.bin    every client asset, one after another
 *   cellb-builds/<app>/meta.json     what the build is and where each asset is in assets.bin;
 *                                    written last and removed first, so a build without it
 *                                    (an interrupted save) does not exist
 *
 * Bytes, never JSON arrays: a debugging cache of the build once held EmDash's assets as JSON
 * numbers, ~370 MB on the page's heap.
 */

/** Bumped when a saved build can no longer run on this host (its runtime or layout changed). */
export const BUILD_FORMAT = 1;

export type AppName = "app" | "emdash";
export interface BuildMeta {
  format: number;
  app: AppName;
  /** When it was built (ms since the epoch). */
  at: number;
  buildMs: number;
  routes: number;
  codeBytes: number;
  /** Modules each bundle stage loaded: what the next build's progress bar expects. */
  modules?: { server: number; client: number };
  /** [path, offset, length] in assets.bin. */
  assets: [string, number, number][];
}
export interface SavedBuild {
  meta: BuildMeta;
  code: string;
  clientAssets: Map<string, Uint8Array>;
}

const DIR = "cellb-builds";

async function appDir(app: AppName, create: boolean) {
  const root = await navigator.storage.getDirectory();
  const builds = await root.getDirectoryHandle(DIR, { create });
  return builds.getDirectoryHandle(app, { create });
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, parts: BlobPart[]) {
  const file = await dir.getFileHandle(name, { create: true });
  const w = await file.createWritable();
  try {
    await w.write(new Blob(parts));
    await w.close();
  } catch (err) {
    await w.abort().catch(() => {});
    throw err;
  }
}

async function readFile(dir: FileSystemDirectoryHandle, name: string): Promise<File> {
  return (await dir.getFileHandle(name)).getFile();
}

/** The saved build's description, or undefined (none, interrupted, or of another format). */
export async function savedBuildMeta(app: AppName): Promise<BuildMeta | undefined> {
  try {
    const meta = JSON.parse(await (await readFile(await appDir(app, false), "meta.json")).text());
    return meta?.format === BUILD_FORMAT && meta.app === app ? (meta as BuildMeta) : undefined;
  } catch {
    return undefined;
  }
}

/** The saved build of `app`, or undefined. */
export async function loadBuild(app: AppName): Promise<SavedBuild | undefined> {
  const meta = await savedBuildMeta(app);
  if (!meta) return undefined;
  const dir = await appDir(app, false);
  const code = await (await readFile(dir, "worker.js")).text();
  const assets = new Uint8Array(await (await readFile(dir, "assets.bin")).arrayBuffer());
  const clientAssets = new Map<string, Uint8Array>();
  for (const [path, offset, length] of meta.assets)
    clientAssets.set(path, assets.subarray(offset, offset + length));
  return { meta, code, clientAssets };
}

/** Saves a build of `app`, replacing the one before. */
export async function saveBuild(
  app: AppName,
  b: {
    code: string;
    clientAssets: Map<string, Uint8Array>;
    buildMs: number;
    routes: number;
    modules?: { server: number; client: number };
  },
): Promise<BuildMeta> {
  const dir = await appDir(app, true);
  await dir.removeEntry("meta.json").catch(() => {});
  const assets: [string, number, number][] = [];
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (const [path, bytes] of b.clientAssets) {
    assets.push([path, offset, bytes.length]);
    parts.push(bytes);
    offset += bytes.length;
  }
  const code = new TextEncoder().encode(b.code);
  await writeFile(dir, "worker.js", [code as BlobPart]);
  await writeFile(dir, "assets.bin", parts as BlobPart[]);
  const meta: BuildMeta = {
    format: BUILD_FORMAT,
    app,
    at: Date.now(),
    buildMs: b.buildMs,
    routes: b.routes,
    codeBytes: code.length,
    modules: b.modules,
    assets,
  };
  await writeFile(dir, "meta.json", [JSON.stringify(meta)]);
  return meta;
}

/** Forgets the saved build of `app` (the next visit compiles it). */
export async function removeBuild(app: AppName): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const builds = await root.getDirectoryHandle(DIR);
    await builds.removeEntry(app, { recursive: true });
  } catch {}
}
