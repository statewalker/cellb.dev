// Editing a project: pure operations over its path → bytes map and its folders. The page applies
// them to its copy and, for a folder opened with the File System Access API, to the disk as well
// (folder.ts). Paths are absolute ("/client/src/main.tsx"); a folder is a path prefix, and a
// folder with no file in it lives in `dirs` until it gets one.

import { normalizePath, type ProjectFiles } from "./project";

export interface Workspace {
  files: ProjectFiles;
  /** Folders with no file in them yet (made with "New folder"). */
  dirs: Set<string>;
}

/** A failed edit: the message is meant for the person editing. */
export class EditError extends Error {
  override name = "EditError";
}

const isUnder = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/** Every folder of the workspace: the parents of its files, and its empty folders. */
export function allDirs(ws: Workspace): Set<string> {
  const out = new Set<string>();
  const add = (dir: string) => {
    for (let d = dir; d !== "/" && !out.has(d); d = parentOf(d)) out.add(d);
  };
  for (const path of ws.files.keys()) add(parentOf(path));
  for (const dir of ws.dirs) add(dir);
  return out;
}

export const isDir = (ws: Workspace, path: string) => allDirs(ws).has(path);

/**
 * A path typed by the person editing, made absolute and checked: no empty name, no "." or ".."
 * escaping the root, no characters a file system refuses.
 */
export function checkPath(input: string): string {
  const raw = input.trim();
  if (!raw || raw === "/") throw new EditError("give a name");
  if (/[\\:*?"<>|]/.test(raw)) throw new EditError('a name cannot hold \\ : * ? " < > |');
  if (raw.split("/").some((p) => p === "..")) throw new EditError('".." is not allowed');
  const path = normalizePath(`/${raw}`);
  if (path === "/") throw new EditError("give a name");
  return path;
}

function assertFree(ws: Workspace, path: string) {
  if (ws.files.has(path)) throw new EditError(`${path.slice(1)} already exists`);
  if (isDir(ws, path)) throw new EditError(`${path.slice(1)} is already a folder`);
  // A file cannot be the parent of something new.
  for (let d = parentOf(path); d !== "/"; d = parentOf(d))
    if (ws.files.has(d)) throw new EditError(`${d.slice(1)} is a file`);
}

/** Drops the empty folders that now have a file below them. */
function prune(dirs: Set<string>, files: ProjectFiles): Set<string> {
  const paths = [...files.keys()];
  return new Set([...dirs].filter((d) => !paths.some((p) => isUnder(p, d))));
}

/** Keeps the folder `path` was in when nothing is left in it (the disk keeps it too). */
function keepParent(dirs: Set<string>, files: ProjectFiles, path: string): Set<string> {
  const parent = parentOf(path);
  if (parent === "/" || [...files.keys()].some((p) => isUnder(p, parent))) return dirs;
  return new Set(dirs).add(parent);
}

export function addFile(
  ws: Workspace,
  path: string,
  bytes: Uint8Array = new Uint8Array(),
): Workspace {
  assertFree(ws, path);
  const files = new Map(ws.files).set(path, bytes);
  return { files, dirs: prune(ws.dirs, files) };
}

export function addDir(ws: Workspace, path: string): Workspace {
  assertFree(ws, path);
  return { files: ws.files, dirs: new Set(ws.dirs).add(path) };
}

export function writeFile(ws: Workspace, path: string, bytes: Uint8Array): Workspace {
  if (!ws.files.has(path)) throw new EditError(`${path.slice(1)} does not exist`);
  return { files: new Map(ws.files).set(path, bytes), dirs: ws.dirs };
}

/** Removes a file, or a folder with everything below it. Returns the file paths removed. */
export function remove(ws: Workspace, path: string): { ws: Workspace; removed: string[] } {
  if (ws.files.has(path)) {
    const files = new Map(ws.files);
    files.delete(path);
    return { ws: { files, dirs: keepParent(ws.dirs, files, path) }, removed: [path] };
  }
  if (!isDir(ws, path)) throw new EditError(`${path.slice(1)} does not exist`);
  const removed = [...ws.files.keys()].filter((p) => isUnder(p, path));
  const files = new Map([...ws.files].filter(([p]) => !isUnder(p, path)));
  const dirs = new Set([...ws.dirs].filter((d) => !isUnder(d, path)));
  return { ws: { files, dirs: keepParent(dirs, files, path) }, removed };
}

/**
 * Renames or moves a file or a folder (with everything below it) to `to`. Returns the moves made,
 * old path → new path, for every file, so the page can follow the selection and its drafts.
 */
export function move(
  ws: Workspace,
  from: string,
  to: string,
): { ws: Workspace; moved: Map<string, string> } {
  if (from === to) return { ws, moved: new Map() };
  const dir = !ws.files.has(from);
  if (dir && !isDir(ws, from)) throw new EditError(`${from.slice(1)} does not exist`);
  if (dir && isUnder(to, from)) throw new EditError("a folder cannot move into itself");
  assertFree(ws, to);
  const moved = new Map<string, string>();
  const files: ProjectFiles = new Map();
  for (const [p, bytes] of ws.files) {
    const next = isUnder(p, from) ? `${to}${p.slice(from.length)}` : p;
    if (next !== p) moved.set(p, next);
    files.set(next, bytes);
  }
  const dirs = new Set(
    [...ws.dirs].map((d) => (isUnder(d, from) ? `${to}${d.slice(from.length)}` : d)),
  );
  return { ws: { files, dirs: keepParent(prune(dirs, files), files, from) }, moved };
}

/** The path `name` gets when dropped into folder `dir` ("/" for the root). */
export const intoDir = (dir: string, path: string) =>
  normalizePath(`${dir}/${path.slice(path.lastIndexOf("/") + 1)}`);

export { parentOf };
