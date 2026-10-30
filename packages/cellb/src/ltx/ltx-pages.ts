/**
 * Page-level random access to a cell kept as celld keeps it: LTX files in a bucket
 * (`…/ltx/e<epoch>/<level>/<min>-<max>.ltx`), a snapshot (TXID 1..N) and the incremental files
 * after it. Nothing is read whole: an LTX file ends with a page index (pgno → offset, size), so
 * opening a file reads its 100-byte header and its index, and a page is ONE range read plus an
 * LZ4 decode. The newest file holding a page wins; `compact` folds them into a new snapshot.
 *
 * This is the read side a SQLite VFS needs to serve a database from any FilesApi (OPFS, File
 * System Access, IndexedDB, S3…) without loading it: xRead → `readPage` (through a page cache);
 * the write side is the existing LTX log (one incremental file per commit).
 */
import type { FilesApi } from "@statewalker/webrun-files";
import { encodeLtx, type LtxHeader, lockPgno } from "./ltx.js";
import { lz4Decompress, lz4FrameDecompress } from "./lz4.js";

const HEADER_SIZE = 100;
const PAGE_HEADER_FLAG_SIZE = 1;

async function readRange(
  files: FilesApi,
  path: string,
  start: number,
  length: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of files.read(path, { start, length })) chunks.push(c);
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) out.set(c, o), (o += c.length);
  return out;
}

export interface LtxPages {
  path: string;
  header: LtxHeader;
  /** pgno → [offset of the page's 6-byte header, size including it]. */
  index: Map<number, [number, number]>;
  /** One range read and an LZ4 decode. */
  readPage(pgno: number): Promise<Uint8Array | undefined>;
}

/** Opens an LTX file for page reads: reads its header and its page index only. */
export async function openLtxPages(files: FilesApi, path: string): Promise<LtxPages> {
  const size =
    (await files.stats(path))?.kind === "file"
      ? ((await files.stats(path)) as { size: number }).size
      : 0;
  if (size < HEADER_SIZE + 6 + 24) throw new Error(`ltx: ${path} is too small`);
  const head = await readRange(files, path, 0, HEADER_SIZE);
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (new TextDecoder().decode(head.subarray(0, 4)) !== "LTX1")
    throw new Error(`ltx: ${path}: bad magic`);
  const header: LtxHeader = {
    flags: hv.getUint32(4),
    pageSize: hv.getUint32(8),
    commit: hv.getUint32(12),
    minTXID: hv.getBigUint64(16),
    maxTXID: hv.getBigUint64(24),
    timestamp: Number(hv.getBigInt64(32)),
    preApplyChecksum: hv.getBigUint64(40),
  };
  // Trailer: … index | u64 index length | u64 post-apply checksum | u64 file checksum.
  const tail = await readRange(files, path, size - 24, 24);
  const idxLen = Number(new DataView(tail.buffer, tail.byteOffset, 24).getBigUint64(0));
  const idx = await readRange(files, path, size - 24 - idxLen, idxLen);
  const index = new Map<number, [number, number]>();
  let o = 0;
  const varint = () => {
    let x = 0;
    let shift = 0;
    let b: number;
    do {
      b = idx[o++];
      x += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return x;
  };
  for (;;) {
    const pgno = varint();
    if (pgno === 0) break;
    const offset = varint();
    index.set(pgno, [offset, varint()]);
  }
  return {
    path,
    header,
    index,
    async readPage(pgno) {
      const at = index.get(pgno);
      if (!at) return undefined;
      const b = await readRange(files, path, at[0], at[1]);
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      if (v.getUint16(4) & PAGE_HEADER_FLAG_SIZE)
        return lz4Decompress(b.subarray(10, 10 + v.getUint32(6)), header.pageSize);
      return lz4FrameDecompress(b.subarray(6), header.pageSize);
    },
  };
}

export interface PagedCell {
  pageSize: number;
  /** Database size in pages, after the newest file. */
  pageCount: number;
  maxTXID: bigint;
  /** The files, oldest first (the snapshot, then the incremental ones). */
  files: LtxPages[];
  /** The page as of the newest file holding it (zeros past the database end). */
  readPage(pgno: number): Promise<Uint8Array>;
  /** Which file serves each page (for tests and traces). */
  source(pgno: number): string | undefined;
}

/**
 * A cell's pages over its LTX files: the newest snapshot (min TXID 1) and the files after it,
 * in TXID order. Only headers and page indexes are read.
 */
export async function openPagedCell(files: FilesApi, paths: string[]): Promise<PagedCell> {
  const opened = await Promise.all(paths.map((p) => openLtxPages(files, p)));
  opened.sort((a, b) =>
    a.header.maxTXID < b.header.maxTXID ? -1 : a.header.maxTXID > b.header.maxTXID ? 1 : 0,
  );
  let snapshotAt = -1;
  opened.forEach((f, i) => {
    if (f.header.minTXID === 1n) snapshotAt = i;
  });
  if (snapshotAt < 0) throw new Error("ltx: no snapshot among the cell's files");
  const chain = opened.slice(snapshotAt);
  for (let i = 1; i < chain.length; i++)
    if (chain[i].header.minTXID !== chain[i - 1].header.maxTXID + 1n)
      throw new Error(`ltx: gap before ${chain[i].path}`);
  const newest = chain[chain.length - 1].header;
  const owner = new Map<number, LtxPages>();
  for (const f of chain) for (const pgno of f.index.keys()) owner.set(pgno, f);
  return {
    pageSize: newest.pageSize,
    pageCount: newest.commit,
    maxTXID: newest.maxTXID,
    files: chain,
    source: (pgno) => owner.get(pgno)?.path,
    async readPage(pgno) {
      const page = pgno <= newest.commit ? await owner.get(pgno)?.readPage(pgno) : undefined;
      return page ?? new Uint8Array(newest.pageSize);
    },
  };
}

/**
 * Folds a cell's files into one snapshot (TXID 1..maxTXID), page by page through `readPage`,
 * in celld's format; the caller writes it as `<level>/<1>-<max>.ltx` and removes what it
 * replaces. (encodeLtx takes the pages at once: a streaming encoder would bound memory to one
 * page.)
 */
export async function compactPagedCell(
  cell: PagedCell,
  timestamp = Date.now(),
): Promise<Uint8Array> {
  const pages = new Map<number, Uint8Array>();
  const lock = lockPgno(cell.pageSize);
  for (let pgno = 1; pgno <= cell.pageCount; pgno++)
    if (pgno !== lock) pages.set(pgno, await cell.readPage(pgno));
  return encodeLtx({
    header: {
      pageSize: cell.pageSize,
      commit: cell.pageCount,
      minTXID: 1n,
      maxTXID: cell.maxTXID,
      timestamp,
      preApplyChecksum: 0n,
    },
    pages,
    postApplyChecksum: 0n,
  });
}
