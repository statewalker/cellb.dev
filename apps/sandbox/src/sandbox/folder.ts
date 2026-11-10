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
