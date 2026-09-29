import type { FilesApi } from "@statewalker/webrun-files";
import { tryReadFile } from "@statewalker/webrun-files";
import type { BackupInfo, CellBackup } from "../ports.js";

export interface FilesApiBackupOptions {
  /** Folder inside the FilesApi (default "/cells"). */
  dir?: string;
  intervalMs?: number;
  onError?: (cellKey: string, error: unknown) => void;
}

/**
 * CellBackup on a @statewalker/webrun-files FilesApi (OPFS, S3, memory, node fs…).
 * Layout per cell:  {dir}/{Class}/{hexId}.sqlite  (+ .json with the BackupInfo).
 * The image is written to a temporary file and `move`d over the previous one, so a
 * crash during upload never leaves a truncated image as "the" backup (on backends
 * whose move is atomic; S3 has no rename — there the last complete PUT wins).
 */
export function filesApiBackup(files: FilesApi, opts: FilesApiBackupOptions = {}): CellBackup {
  const dir = (opts.dir ?? "/cells").replace(/\/$/, "");
  const path = (cellKey: string) =>
    `${dir}/${cellKey
      .split("/")
      .map((p) => p.replace(/[^\w.-]/g, "_"))
      .join("/")}.sqlite`;
  return {
    intervalMs: opts.intervalMs,
    onError: opts.onError,
    async save(cellKey: string, image: Uint8Array, info: BackupInfo) {
      const target = path(cellKey);
      const tmp = `${target}.${info.seq}.${info.takenAt}.tmp`;
      await files.write(tmp, [image]);
      await files.move(tmp, target);
      await files.write(`${target}.json`, [
        new TextEncoder().encode(JSON.stringify({ cellKey, ...info, bytes: image.byteLength })),
      ]);
    },
    async load(cellKey: string) {
      return tryReadFile(files, path(cellKey));
    },
  };
}
