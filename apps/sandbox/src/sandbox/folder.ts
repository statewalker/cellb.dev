// Picking a local folder: the File System Access API (`showDirectoryPicker`) where the browser has
// it (the handle goes to the studio worker, which serves it as a FilesApi: BrowserFilesApi), a
// `webkitdirectory` file input elsewhere (read once, kept in memory).

import { type ProjectFiles, SKIPPED_DIRS } from "./project";

const MAX_FILES = 3000;
const MAX_BYTES = 50 * 1024 * 1024;

export interface LocalFolder {
  name: string;
  /** Present with the File System Access API: the folder can be read again. */
  handle?: FileSystemDirectoryHandle;
}

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

// Write access: the folder is picked read-only; the first edit asks for write access (the browser
// shows a prompt once, on that click), and the studio worker's writes use it. OPFS handles (the
// e2e's stand-in for a picked folder) are always writable.

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
