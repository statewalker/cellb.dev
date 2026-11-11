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

/** Asks for write access to the folder; false if it is refused. */
export async function ensureWritable(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as PermissionHandle;
  const mode = { mode: "readwrite" as const };
  if (!h.queryPermission || (await h.queryPermission(mode)) === "granted") return true;
  return (await h.requestPermission?.(mode)) === "granted";
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

/**
 * Moves a file or a folder: its files are written at their new paths (`moved`, old → new), then
 * the old entry is removed. Copying keeps it to the API every browser with the picker has.
 */
export async function moveInFolder(
  root: FileSystemDirectoryHandle,
  from: string,
  to: string,
  moved: Map<string, string>,
  bytesOf: (path: string) => Uint8Array | undefined,
  dir: boolean,
): Promise<void> {
  if (dir) await mkdirInFolder(root, to);
  for (const [, next] of moved) {
    const bytes = bytesOf(next);
    if (bytes) await writeToFolder(root, next, bytes);
  }
  await removeFromFolder(root, from);
}
