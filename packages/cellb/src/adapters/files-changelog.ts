import type { FilesApi } from "@statewalker/webrun-files";
import { tryReadFile } from "@statewalker/webrun-files";
import type { BackupInfo, CellBackup, CellDurability, CommitChanges } from "../ports.js";

/**
 * Transaction-log durability on a webrun-files FilesApi (OPFS, S3, node fs, memory…) —
 * celld's model (every acknowledged write is in the bucket) with SQLite *changesets*
 * instead of LTX page frames:
 *
 *   {dir}/{cell}/log/{epoch}-{logSeq}.seg   one segment per committed transaction
 *   {dir}/{cell}/snapshot.sqlite (+ .json)  periodic image, carrying its logSeq
 *
 * `committed()` resolves when the segment is written, and the output gate holds every
 * reply until then: RPO = 0 against the FilesApi. Restore = snapshot + the segments after
 * its logSeq. After a successful snapshot the segments it contains are deleted.
 * `epoch` (e.g. a lease fencing token) prefixes segment names: segments of different owners
 * never overwrite each other, and a stale owner's segments are void from the first sequence
 * number a newer owner wrote (celld fences the same way with the epoch in its log keys).
 */
export interface ChangeLogOptions {
  dir?: string;
  /** Fencing epoch of the current owner (default 0). */
  epoch?: number;
  /** Snapshot interval (compaction); default: no periodic snapshot. */
  intervalMs?: number;
  onError?: (cellKey: string, error: unknown) => void;
}

const MAGIC = new TextEncoder().encode("CLOG1");
const pad = (n: number, w: number) => String(n).padStart(w, "0");

export function encodeSegment(c: CommitChanges, epoch: number): Uint8Array {
  const header = new TextEncoder().encode(
    JSON.stringify({
      logSeq: c.logSeq,
      epoch,
      ddl: c.ddl,
      statements: c.statements,
      at: Date.now(),
    }),
  );
  const out = new Uint8Array(MAGIC.length + 4 + header.length + c.changeset.byteLength);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(MAGIC.length, header.length);
  out.set(header, MAGIC.length + 4);
  out.set(c.changeset, MAGIC.length + 4 + header.length);
  return out;
}

export function decodeSegment(bytes: Uint8Array): CommitChanges & { epoch: number } {
  for (let i = 0; i < MAGIC.length; i++)
    if (bytes[i] !== MAGIC[i]) throw new Error("not a change-log segment");
  const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(MAGIC.length);
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(MAGIC.length + 4, MAGIC.length + 4 + len)),
  );
  return { ...header, changeset: bytes.slice(MAGIC.length + 4 + len) };
}

export function filesApiChangeLog(
  files: FilesApi,
  opts: ChangeLogOptions = {},
): CellDurability & CellBackup {
  const dir = (opts.dir ?? "/cells").replace(/\/$/, "");
  const epoch = opts.epoch ?? 0;
  const cellDir = (cellKey: string) =>
    `${dir}/${cellKey
      .split("/")
      .map((p) => p.replace(/[^\w.-]/g, "_"))
      .join("/")}`;
  const segments = async (cellKey: string) => {
    const logDir = `${cellDir(cellKey)}/log`;
    const out: { path: string; epoch: number; logSeq: number }[] = [];
    if (!(await files.exists(logDir))) return out;
    for await (const f of files.list(logDir)) {
      const m = /(\d+)-(\d+)\.seg$/.exec(f.path);
      if (f.kind === "file" && m)
        out.push({ path: f.path, epoch: Number(m[1]), logSeq: Number(m[2]) });
    }
    // Fencing: a segment written by an older owner (epoch e) is void from the first logSeq
    // that a newer owner (epoch > e) wrote — a stale owner's late writes never replay.
    const firstOfEpoch = new Map<number, number>();
    for (const s of out)
      firstOfEpoch.set(s.epoch, Math.min(firstOfEpoch.get(s.epoch) ?? s.logSeq, s.logSeq));
    const valid = out.filter(
      (s) => ![...firstOfEpoch].some(([e, first]) => e > s.epoch && first <= s.logSeq),
    );
    return valid.sort((a, b) => a.logSeq - b.logSeq || b.epoch - a.epoch);
  };

  return {
    captureChanges: true,
    intervalMs: opts.intervalMs,
    onError: opts.onError,

    async committed(cellKey, { changes }) {
      if (!changes) return;
      const name = `${pad(epoch, 10)}-${pad(changes.logSeq, 12)}.seg`;
      await files.write(`${cellDir(cellKey)}/log/${name}`, [encodeSegment(changes, epoch)]);
    },

    async save(cellKey: string, image: Uint8Array, info: BackupInfo) {
      const base = cellDir(cellKey);
      const tmp = `${base}/snapshot.${info.takenAt}.tmp`;
      await files.write(tmp, [image]);
      await files.move(tmp, `${base}/snapshot.sqlite`);
      await files.write(`${base}/snapshot.json`, [
        new TextEncoder().encode(JSON.stringify({ cellKey, ...info })),
      ]);
      // Compaction: the image contains every segment up to its logSeq.
      for (const s of await segments(cellKey))
        if (s.logSeq <= (info.logSeq ?? 0)) await files.remove(s.path);
    },

    async load(cellKey: string) {
      return tryReadFile(files, `${cellDir(cellKey)}/snapshot.sqlite`);
    },

    async *replay(cellKey: string, afterLogSeq: number) {
      let last = afterLogSeq;
      for (const s of await segments(cellKey)) {
        if (s.logSeq <= last) continue;
        if (s.logSeq !== last + 1)
          throw new Error(`change log of ${cellKey}: segment ${last + 1} is missing`);
        const bytes = await tryReadFile(files, s.path);
        if (!bytes) throw new Error(`change log of ${cellKey}: cannot read ${s.path}`);
        last = s.logSeq;
        yield decodeSegment(bytes);
      }
    },
  };
}
