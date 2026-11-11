// studio: the shapes the gate and its holders exchange (from flue-capfs-do's sql-fs.ts, whose
// store this package replaces with files-store.ts over any FilesApi).
import { asBytes } from "./bytes.ts";
import { fsError } from "./path.ts";

export interface PlainStat {
  /** Stable per path while it exists: just-bash compares (dev, ino) for "same file". */
  ino: number;
  dev: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mode: number;
  mtime: string;
}

export interface DirEntryStat {
  name: string;
  isDirectory: boolean;
  size: number;
  mtime: string;
}

export interface Entry {
  path: string;
  kind: "file" | "dir";
}

export function bytesArg(d: unknown): Uint8Array {
  const b = asBytes(d);
  if (!b) throw fsError("EINVAL", "binary content must be a Uint8Array or an ArrayBuffer");
  return b;
}
