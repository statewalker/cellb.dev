// A project's data on Node as files, to move it to another host (#199; statewalker-root#263, the
// Move of a fragment): every file of its data directory (each cell's SQLite database, CellB's own
// `__cellb_*` databases, R2 objects and other files under `files/`), as `[path, bytes]`. The cells'
// names are the ones `nodeSqliteOpener(dir)` and a browser's OPFS pool give them, so the files of
// a browser's `exportCells()` import here as they are, and these import there.
//
// A move copies, it never transforms: both hosts must run the same project version. Only one host
// may write a project's objects at a time (docs/ownership-and-durability.md), so an export can be a
// hand-over: the directory gets a marker, and `loadProject` refuses it until it is reactivated
// (`reactivateCellFiles`) or deleted.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** A file of a project's data: its path in the data directory (`/`-separated) and its bytes. */
export type CellFile = [path: string, bytes: Uint8Array];

/** The marker a hand-over leaves in the source's data directory. Never exported or imported. */
export const HAND_OVER_MARKER = ".cellb-handed-over.json";

/** What a hand-over marker records. */
export interface HandOver {
  /** When the data was handed over, as an ISO date. */
  readonly at: string;
  /** Where it went, if the caller said (a route, a host's name). */
  readonly to?: string;
}

const SEGMENT = /^[\w.-]+$/;

/** A path an import may write: relative, `/`-separated segments of `[\w.-]`, no `.` or `..`. */
function checkPath(path: string): string[] {
  const segments = path.split("/");
  for (const s of segments)
    if (!SEGMENT.test(s) || s === "." || s === "..")
      throw new Error(`"${path}" is not a path of a project's data`);
  if (segments.length === 1 && segments[0] === HAND_OVER_MARKER)
    throw new Error(`"${path}" is the hand-over marker, not data`);
  return segments;
}

/** The files under `dir`, as paths relative to it; none when it does not exist. */
function listFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), path));
    else if (entry.isFile() && path !== HAND_OVER_MARKER) out.push(path);
  }
  return out;
}

/** The hand-over marker of `dir`, or undefined when its data was not handed over. */
export function handedOver(dir: string): HandOver | undefined {
  const marker = join(dir, HAND_OVER_MARKER);
  if (!existsSync(marker)) return undefined;
  try {
    return JSON.parse(readFileSync(marker, "utf8")) as HandOver;
  } catch {
    // Unreadable, it still marks a hand-over: the guard fails closed.
    return { at: "" };
  }
}

/**
 * Every file of a project's data directory, sorted by path. Call it with the project closed: a
 * database read while its project runs may be read half written. With `handOver`, the directory
 * is marked as handed over first, so `loadProject` refuses it from then on.
 */
export function exportCellFiles(
  dir: string,
  options: { handOver?: boolean | HandOver } = {},
): CellFile[] {
  if (options.handOver) {
    mkdirSync(dir, { recursive: true });
    const record: HandOver =
      typeof options.handOver === "object" ? options.handOver : { at: new Date().toISOString() };
    writeFileSync(join(dir, HAND_OVER_MARKER), JSON.stringify(record));
  }
  return listFiles(dir).map(
    (path): CellFile => [path, new Uint8Array(readFileSync(join(dir, ...path.split("/"))))],
  );
}

/** What an import wrote. */
export interface ImportReport {
  /** The paths written, sorted. */
  readonly files: string[];
  /** Their bytes in all. */
  readonly bytes: number;
}

/**
 * Writes exported files into a project's data directory, for `loadProject(dir, { data: dir })`.
 * Refuses a directory that holds anything (data, or a hand-over marker) unless `overwrite`, which
 * deletes what it holds first; refuses any path outside it. Nothing is written when it refuses.
 */
export function importCellFiles(
  dir: string,
  files: readonly CellFile[],
  options: { overwrite?: boolean } = {},
): ImportReport {
  const checked = files.map(([path, bytes]) => ({ segments: checkPath(path), path, bytes }));
  const seen = new Set<string>();
  for (const { path } of checked) {
    if (seen.has(path)) throw new Error(`"${path}" is given twice`);
    seen.add(path);
  }
  const held = existsSync(dir) ? readdirSync(dir) : [];
  if (held.length > 0 && !options.overwrite)
    throw new Error(
      `${dir} already holds ${handedOver(dir) ? "handed-over data" : "data"}: pass { overwrite: true } to replace it`,
    );
  if (held.length > 0) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let bytes = 0;
  for (const { segments, bytes: b } of checked) {
    const target = join(dir, ...segments);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, b);
    bytes += b.byteLength;
  }
  return { files: checked.map((c) => c.path).sort(), bytes };
}

/** Lifts a hand-over: the directory's project can be loaded again, with the data it kept. */
export function reactivateCellFiles(dir: string): boolean {
  const marker = join(dir, HAND_OVER_MARKER);
  if (!existsSync(marker)) return false;
  if (!statSync(marker).isFile()) throw new Error(`${marker} is not a hand-over marker`);
  rmSync(marker);
  return true;
}

/** Throws when `dir`'s data was handed over: no project may write it until it is reactivated. */
export function assertNotHandedOver(dir: string): void {
  const record = handedOver(dir);
  if (record)
    throw new Error(
      `${dir} was handed over${record.to ? ` to ${record.to}` : ""}${record.at ? ` at ${record.at}` : ""}: reactivate it or delete it before loading a project on it`,
    );
}
