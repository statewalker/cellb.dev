import type { FilesApi } from "@statewalker/webrun-files";
import { tryReadFile } from "@statewalker/webrun-files";
import { decodeLtx, encodeLtx, ltxFileName } from "../ltx/ltx.js";
import type { BackupInfo, CellBackup, CellDurability } from "../ports.js";

/**
 * Page-level transaction log in celld's format: one LTX v3 file per committed transaction
 * (src/ltx, verified on celld's own files), on a webrun-files FilesApi.
 *
 *   {dir}/{Class}:{id}/ltx/e{epoch}/0000/{minTXID:016x}-{maxTXID:016x}.ltx
 *
 * — celld's bucket layout (level-0 directory "0000"), so the same keys hold the same files
 * on both. Each owner epoch is a new generation that starts with a snapshot (TXID 1); a
 * restore reads the highest epoch only, as celld does.
 *
 * The runtime hands over the committed database image (`capturePages`); the pages that
 * differ from the previous image become the transaction's LTX file (the first one is a
 * snapshot: every page). `committed()` resolves once the file is stored and the output gate
 * holds replies until then: RPO 0 against the FilesApi. Restore applies the files in TXID
 * order (a snapshot file restarts from its pages). `save()` compacts: one snapshot file
 * covering 1..TXID replaces the files it contains.
 *
 * Cost: an image per commit — O(database size), fine for the small databases of cells; a
 * VFS-level page hook (SQLite WASM) would make it O(changed pages).
 */
export interface LtxLogOptions {
  dir?: string;
  epoch?: number;
  intervalMs?: number;
  onError?: (cellKey: string, error: unknown) => void;
}

const pageSizeOf = (image: Uint8Array) => {
  const n = (image[16] << 8) | image[17];
  return n === 1 ? 65536 : n;
};

export function filesApiLtxLog(
  files: FilesApi,
  opts: LtxLogOptions = {},
): CellDurability & CellBackup {
  const dir = (opts.dir ?? "/cells").replace(/\/$/, "");
  // cellKey "Class/idhex" → celld's cell name "Class:idhex"
  const cellDir = (cellKey: string) => `${dir}/${cellKey.replace("/", ":")}/ltx`;
  // Per cell: the last TXID, its epoch, and (diff path only) the last image.
  const last = new Map<string, { txid: bigint; image: Uint8Array | undefined; epoch: number }>();

  /** The files of the highest epoch, in TXID order. */
  const listFiles = async (cellKey: string) => {
    const out: { path: string; epoch: number; min: bigint; max: bigint }[] = [];
    const root = cellDir(cellKey);
    if (!(await files.exists(root))) return { epoch: -1, files: out };
    for await (const f of files.list(root, { recursive: true })) {
      const m = /\/e(\d+)\/\d{4}\/([0-9a-f]{16})-([0-9a-f]{16})\.ltx$/.exec(f.path);
      if (f.kind === "file" && m)
        out.push({
          path: f.path,
          epoch: Number(m[1]),
          min: BigInt(`0x${m[2]}`),
          max: BigInt(`0x${m[3]}`),
        });
    }
    const epoch = out.reduce((e, f) => Math.max(e, f.epoch), -1);
    return {
      epoch,
      files: out
        .filter((f) => f.epoch === epoch)
        .sort((a, b) => (a.max < b.max ? -1 : a.max > b.max ? 1 : 0)),
    };
  };

  /** Rebuilds the database image from the stored files. */
  const rebuild = async (
    cellKey: string,
  ): Promise<{ txid: bigint; image?: Uint8Array; epoch: number }> => {
    const pages = new Map<number, Uint8Array>();
    let txid = 0n;
    let pageSize = 0;
    let commit = 0;
    const listed = await listFiles(cellKey);
    for (const f of listed.files) {
      if (f.max <= txid) continue;
      if (f.min > txid + 1n && f.min !== 1n)
        throw new Error(`ltx log of ${cellKey}: TXID ${txid + 1n} is missing`);
      const bytes = await tryReadFile(files, f.path);
      if (!bytes) throw new Error(`ltx log of ${cellKey}: cannot read ${f.path}`);
      const ltx = decodeLtx(bytes); // verifies the file checksum
      if (ltx.header.minTXID === 1n) pages.clear(); // a snapshot restarts from its pages
      for (const [p, d] of ltx.pages) pages.set(p, d);
      pageSize = ltx.header.pageSize;
      commit = ltx.header.commit;
      txid = ltx.header.maxTXID;
    }
    if (!txid) return { txid, epoch: listed.epoch };
    const image = new Uint8Array(commit * pageSize);
    for (const [p, d] of pages) if (p <= commit) image.set(d, (p - 1) * pageSize);
    return { txid, image, epoch: listed.epoch };
  };

  const write = async (
    cellKey: string,
    epoch: number,
    min: bigint,
    max: bigint,
    pageSize: number,
    commit: number,
    pages: Map<number, Uint8Array>,
  ) => {
    const bytes = encodeLtx({
      header: {
        pageSize,
        commit,
        minTXID: min,
        maxTXID: max,
        timestamp: Date.now(),
        preApplyChecksum: 0n, // celld 0.6.2 leaves the rolling checksums at 0
      },
      pages,
      postApplyChecksum: 0n,
    });
    await files.write(`${cellDir(cellKey)}/e${epoch}/0000/${ltxFileName(min, max)}`, [bytes]);
  };

  return {
    capturePages: true,
    intervalMs: opts.intervalMs,
    onError: opts.onError,

    async committed(cellKey, { image: imageOrThunk, pages: hooked, epoch: leaseEpoch }) {
      const epoch = leaseEpoch ?? opts.epoch ?? 0;
      let prev = last.get(cellKey);
      if (!prev) {
        const r = await rebuild(cellKey);
        prev = { txid: r.txid, image: r.image, epoch: r.epoch };
      }
      // A new owner epoch is a new generation: it starts with a snapshot at TXID 1.
      if (prev.epoch !== epoch) prev = { txid: 0n, image: prev.image, epoch };
      const snapshot = prev.txid === 0n;
      const txid = prev.txid + 1n;
      const imageNow = () => (typeof imageOrThunk === "function" ? imageOrThunk() : imageOrThunk);

      // 1. The page hook gave the changed pages (SQLite WASM): O(changed pages).
      if (hooked && !snapshot) {
        if (!hooked.pages.size) return; // nothing written
        await write(cellKey, epoch, txid, txid, hooked.pageSize, hooked.pageCount, hooked.pages);
        last.set(cellKey, { txid, image: undefined, epoch });
        return;
      }
      // 2. Otherwise diff the committed image against the previous one (O(database size)).
      const image = imageNow();
      if (!image?.byteLength) return;
      const pageSize = pageSizeOf(image);
      const changed = new Map<number, Uint8Array>();
      for (let p = 1, o = 0; o < image.byteLength; p++, o += pageSize) {
        const page = image.subarray(o, o + pageSize);
        const old = prev.image?.subarray(o, o + pageSize);
        if (snapshot || !old || old.byteLength !== pageSize || !sameBytes(page, old))
          changed.set(p, page.slice());
      }
      if (!changed.size && prev.image?.byteLength === image.byteLength) return;
      await write(
        cellKey,
        epoch,
        snapshot ? 1n : txid,
        txid,
        pageSize,
        image.byteLength / pageSize,
        changed,
      );
      last.set(cellKey, { txid, image: image.slice(), epoch });
    },

    async save(cellKey: string, image: Uint8Array, _info: BackupInfo) {
      // Compaction: one snapshot 1..TXID replaces the files it contains.
      const cur = last.get(cellKey) ?? (await rebuild(cellKey));
      if (!cur.txid) return;
      const epoch = cur.epoch;
      const pageSize = pageSizeOf(image);
      const pages = new Map<number, Uint8Array>();
      for (let p = 1, o = 0; o < image.byteLength; p++, o += pageSize)
        pages.set(p, image.slice(o, o + pageSize));
      const before = (await listFiles(cellKey)).files;
      await write(cellKey, epoch, 1n, cur.txid, pageSize, image.byteLength / pageSize, pages);
      for (const f of before)
        if (f.max <= cur.txid && !(f.min === 1n && f.max === cur.txid)) await files.remove(f.path);
    },

    async load(cellKey: string) {
      const r = await rebuild(cellKey);
      if (r.image) last.set(cellKey, { txid: r.txid, image: r.image.slice(), epoch: r.epoch });
      return r.image;
    },
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
