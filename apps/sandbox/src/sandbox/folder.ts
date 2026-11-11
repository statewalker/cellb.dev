// Reading a local folder: the File System Access API (`showDirectoryPicker`) where the browser has
// it, which also lets the sandbox see later changes; a `webkitdirectory` file input elsewhere.

import { type ProjectFiles, SKIPPED_DIRS } from "./project";

const MAX_FILES = 3000;
const MAX_BYTES = 50 * 1024 * 1024;

export interface LocalFolder {
  name: string;
  /** Present with the File System Access API: the folder can be read again. */
  handle?: FileSystemDirectoryHandle;
}

type DirHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterable<[string, FileSystemHandle]>;
};

export const canPickFolder = () =>
  typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

export async function pickFolder(): Promise<LocalFolder> {
  const pick = (
    globalThis as unknown as {
      showDirectoryPicker(o: { id?: string; mode: "read" }): Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  const handle = await pick({ id: "cellb-sandbox", mode: "read" });
  return { name: handle.name, handle };
}

/** Every file below the folder (installed and generated folders skipped), with a signature. */
export async function readFolder(
  handle: FileSystemDirectoryHandle,
): Promise<{ files: ProjectFiles; signature: string }> {
  const files: ProjectFiles = new Map();
  const sig: string[] = [];
  let bytes = 0;
  async function walk(dir: DirHandle, prefix: string) {
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind === "directory") {
        if (!SKIPPED_DIRS.has(name)) await walk(entry as DirHandle, `${prefix}/${name}`);
        continue;
      }
      if (name === ".DS_Store") continue;
      const file = await (entry as FileSystemFileHandle).getFile();
      bytes += file.size;
      if (files.size >= MAX_FILES || bytes > MAX_BYTES)
        throw new Error(
          `the folder is too large (over ${MAX_FILES} files or 50 MB without node_modules)`,
        );
      const path = `${prefix}/${name}`;
      files.set(path, new Uint8Array(await file.arrayBuffer()));
      sig.push(`${path}:${file.size}:${file.lastModified}`);
    }
  }
  await walk(handle as DirHandle, "");
  return { files, signature: sig.sort().join("\n") };
}

/** Only the signature (sizes and dates): cheap enough to poll for changes. */
export async function folderSignature(handle: FileSystemDirectoryHandle): Promise<string> {
  const sig: string[] = [];
  async function walk(dir: DirHandle, prefix: string) {
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind === "directory") {
        if (!SKIPPED_DIRS.has(name)) await walk(entry as DirHandle, `${prefix}/${name}`);
      } else if (name !== ".DS_Store") {
        const file = await (entry as FileSystemFileHandle).getFile();
        sig.push(`${prefix}/${name}:${file.size}:${file.lastModified}`);
      }
    }
  }
  await walk(handle as DirHandle, "");
  return sig.sort().join("\n");
}

/** The files a `webkitdirectory` input gave (their paths start with the folder's name). */
export async function filesFromInput(
  list: FileList,
): Promise<{ name: string; files: ProjectFiles }> {
  const files: ProjectFiles = new Map();
  let name = "folder";
  let bytes = 0;
  for (const file of Array.from(list)) {
    const parts = (file.webkitRelativePath || file.name).split("/");
    name = parts.length > 1 ? parts[0] : name;
    const rest = parts.length > 1 ? parts.slice(1) : parts;
    if (rest.slice(0, -1).some((d) => SKIPPED_DIRS.has(d)) || rest.at(-1) === ".DS_Store") continue;
    bytes += file.size;
    if (files.size >= MAX_FILES || bytes > MAX_BYTES)
      throw new Error(
        `the folder is too large (over ${MAX_FILES} files or 50 MB without node_modules)`,
      );
    files.set(`/${rest.join("/")}`, new Uint8Array(await file.arrayBuffer()));
  }
  return { name, files };
}

// Writing back to a folder opened with the File System Access API. The folder is opened read-only;
// the first edit asks for write access (the browser shows a prompt once, on that click). OPFS
// handles (the e2e's stand-in for a picked folder) are always writable.

type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission?(o: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(o: { mode: "readwrite" }): Promise<PermissionState>;
};

/**
 * Asks for write access to the folder; false if it is refused. Call it in the click (or key)
 * that makes the edit: the browser shows its prompt only during a user's action.
 */
export async function ensureWritable(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as PermissionHandle;
  const mode = { mode: "readwrite" as const };
  if (!h.queryPermission || (await h.queryPermission(mode)) === "granted") return true;
  try {
    return (await h.requestPermission?.(mode)) === "granted";
  } catch (err) {
    // No user action to ask in (a long drag, for one).
    if ((err as Error).name === "SecurityError")
      throw new Error(
        "the browser asks for write access on a click: use a button once to allow it",
      );
    throw err;
  }
}

async function dirAt(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const name of path.split("/").filter(Boolean))
    dir = await dir.getDirectoryHandle(name, { create });
  return dir;
}

const split = (path: string) => {
  const i = path.lastIndexOf("/");
  return { dir: path.slice(0, i) || "/", name: path.slice(i + 1) };
};

/** Writes a file (and its folders) below the folder. */
export async function writeToFolder(
  root: FileSystemDirectoryHandle,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const { dir, name } = split(path);
  const file = await (await dirAt(root, dir, true)).getFileHandle(name, { create: true });
  const w = await file.createWritable();
  await w.write(bytes as BufferSource);
  await w.close();
}

/** Makes a folder below the folder. */
export async function mkdirInFolder(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  await dirAt(root, path, true);
}

/** Removes a file, or a folder with everything in it. */
export async function removeFromFolder(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<void> {
  const { dir, name } = split(path);
  await (await dirAt(root, dir, false)).removeEntry(name, { recursive: true });
}

type Entry = FileSystemFileHandle | DirHandle;
type Movable = { move?(dir: FileSystemDirectoryHandle, name: string): Promise<void> };

async function entryIn(dir: FileSystemDirectoryHandle, name: string): Promise<Entry | undefined> {
  try {
    return await dir.getFileHandle(name);
  } catch (err) {
    if ((err as Error).name !== "TypeMismatchError" && (err as Error).name !== "NotFoundError")
      throw err;
  }
  try {
    return (await dir.getDirectoryHandle(name)) as DirHandle;
  } catch (err) {
    if ((err as Error).name === "NotFoundError" || (err as Error).name === "TypeMismatchError")
      return undefined;
    throw err;
  }
}

/**
 * Throws if something already is at `path` on disk: also what the sandbox does not load
 * (node_modules, .git…), and, on a disk that ignores case, a name differing only in case.
 */
export async function assertAbsentInFolder(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<void> {
  const { dir, name } = split(path);
  let parent: FileSystemDirectoryHandle;
  try {
    parent = await dirAt(root, dir, false);
  } catch {
    return; // the folder itself is not there yet
  }
  if (await entryIn(parent, name))
    throw new Error(`${path.slice(1)} already exists in the folder on disk`);
}

/** Copies a file or a folder, with everything in it (also what the sandbox did not load). */
async function copyEntry(entry: Entry, into: FileSystemDirectoryHandle, name: string) {
  if (entry.kind === "file") {
    const file = await (entry as FileSystemFileHandle).getFile();
    const w = await (await into.getFileHandle(name, { create: true })).createWritable();
    await w.write(file);
    await w.close();
    return;
  }
  const dir = await into.getDirectoryHandle(name, { create: true });
  for await (const [child, e] of (entry as DirHandle).entries())
    await copyEntry(e as Entry, dir, child);
}

/**
 * Moves a file or a folder on disk, with everything in it: the browser's own `move()` where it
 * has one, else a copy of the entry (read from disk, so files the sandbox skipped come along)
 * and then its removal. A rename that changes only the case goes through a temporary name, as
 * a disk that ignores case would take the new name for the old file.
 */
export async function moveInFolder(
  root: FileSystemDirectoryHandle,
  from: string,
  to: string,
): Promise<void> {
  if (from.toLowerCase() === to.toLowerCase()) {
    const step = `${to}.sandbox-move-${Date.now().toString(36)}`;
    await moveInFolder(root, from, step);
    await moveInFolder(root, step, to);
    return;
  }
  await assertAbsentInFolder(root, to);
  const src = split(from);
  const dst = split(to);
  const srcDir = await dirAt(root, src.dir, false);
  const entry = await entryIn(srcDir, src.name);
  if (!entry) throw new Error(`${from.slice(1)} is not in the folder on disk`);
  const into = await dirAt(root, dst.dir, true);
  const native = entry as unknown as Movable;
  if (typeof native.move === "function") {
    try {
      await native.move(into, dst.name);
      return;
    } catch {
      // Not for this entry or this browser: copy instead.
    }
  }
  try {
    await copyEntry(entry, into, dst.name);
  } catch (err) {
    await into.removeEntry(dst.name, { recursive: true }).catch(() => {});
    throw err;
  }
  await srcDir.removeEntry(src.name, { recursive: true });
}
