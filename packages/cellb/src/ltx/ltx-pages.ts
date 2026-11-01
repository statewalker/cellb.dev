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
import { Crc64 } from "./crc64.js";
import { CHECKSUM_FLAG, type LtxHeader, lockPgno } from "./ltx.js";
import { lz4Compress, lz4Decompress, lz4FrameDecompress } from "./lz4.js";

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
  const got = chunks.reduce((n, c) => n + c.length, 0);
  // A short read is a file that changed or went away under its reader: say which, rather than
  // decode past its end ("Offset is outside the bounds of the DataView").
  if (got !== length) {
    const st = await files.stats(path).catch(() => undefined);
    throw new LtxShortReadError(
      `ltx: short read of ${path}: ${got} of ${length} bytes at ${start} (file ${st?.kind === "file" ? `${(st as { size: number }).size} bytes` : "missing"})`,
    );
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) out.set(c, o), (o += c.length);
  return out;
}

/** A range read that got fewer bytes than asked: the file changed or was removed meanwhile. */
export class LtxShortReadError extends Error {
  name = "LtxShortReadError";
}

export interface LtxPages {
  path: string;
  header: LtxHeader;
  /** pgno → [offset of the page's 6-byte header, size including it]. */
  index: Map<number, [number, number]>;
  /** One range read and an LZ4 decode. */
  readPage(pgno: number): Promise<Uint8Array | undefined>;
  /** Several pages of this file with ONE range read (they are stored in pgno order). */
  readPages(pgnos: number[]): Promise<Map<number, Uint8Array>>;
}

/** Opens an LTX file for page reads: reads its header and its page index only. */
export async function openLtxPages(
  files: FilesApi,
  path: string,
  /** The header and index of a file this process just wrote: nothing is read back. */
  known?: { header: LtxHeader; index: Map<number, [number, number]> },
): Promise<LtxPages> {
  if (known) return pagesOf(files, path, known.header, known.index);
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
  return pagesOf(files, path, header, index);
}

function pagesOf(
  files: FilesApi,
  path: string,
  header: LtxHeader,
  index: Map<number, [number, number]>,
): LtxPages {
  const decodePage = (b: Uint8Array) => {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (v.getUint16(4) & PAGE_HEADER_FLAG_SIZE)
      return lz4Decompress(b.subarray(10, 10 + v.getUint32(6)), header.pageSize);
    return lz4FrameDecompress(b.subarray(6), header.pageSize);
  };
  return {
    path,
    header,
    index,
    async readPage(pgno) {
      const at = index.get(pgno);
      if (!at) return undefined;
      return decodePage(await readRange(files, path, at[0], at[1]));
    },
    async readPages(pgnos) {
      const out = new Map<number, Uint8Array>();
      const wanted = pgnos.filter((p) => index.has(p));
      if (!wanted.length) return out;
      const spans = wanted.map((p) => index.get(p) as [number, number]);
      const start = Math.min(...spans.map((s) => s[0]));
      const end = Math.max(...spans.map((s) => s[0] + s[1]));
      const b = await readRange(files, path, start, end - start);
      wanted.forEach((p, i) =>
        out.set(p, decodePage(b.subarray(spans[i][0] - start, spans[i][0] - start + spans[i][1]))),
      );
      return out;
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
  /** Pages `from`..`from+count-1` (within the database), one range read per file they live in. */
  readRun(from: number, count: number): Promise<Map<number, Uint8Array>>;
  /** Which file serves each page (for tests and traces). */
  source(pgno: number): string | undefined;
  /**
   * Adds the cell's next file (the one just written after `maxTXID`): reads its header and index
   * only, so a commit costs one file whatever the number of files before it.
   */
  append(
    path: string,
    known?: { header: LtxHeader; index: Map<number, [number, number]> },
  ): Promise<void>;
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
  let newest = chain[chain.length - 1].header;
  const owner = new Map<number, LtxPages>();
  for (const f of chain) for (const pgno of f.index.keys()) owner.set(pgno, f);
  const cell: PagedCell = {
    pageSize: newest.pageSize,
    pageCount: newest.commit,
    maxTXID: newest.maxTXID,
    files: chain,
    source: (pgno) => owner.get(pgno)?.path,
    async readPage(pgno) {
      const page = pgno <= cell.pageCount ? await owner.get(pgno)?.readPage(pgno) : undefined;
      return page ?? new Uint8Array(cell.pageSize);
    },
    async readRun(from, count) {
      const byFile = new Map<LtxPages, number[]>();
      const out = new Map<number, Uint8Array>();
      for (let p = from; p < from + count && p <= cell.pageCount; p++) {
        const f = owner.get(p);
        if (!f) out.set(p, new Uint8Array(cell.pageSize));
        else byFile.set(f, [...(byFile.get(f) ?? []), p]);
      }
      for (const [f, pgnos] of byFile) for (const [p, d] of await f.readPages(pgnos)) out.set(p, d);
      return out;
    },
    async append(path, known) {
      const f = await openLtxPages(files, path, known);
      if (f.header.minTXID !== cell.maxTXID + 1n)
        throw new Error(`ltx: ${path} does not follow TXID ${cell.maxTXID}`);
      chain.push(f);
      for (const pgno of f.index.keys()) owner.set(pgno, f);
      newest = f.header;
      cell.pageCount = newest.commit;
      cell.maxTXID = newest.maxTXID;
      for (const [pgno] of owner) if (pgno > cell.pageCount) owner.delete(pgno);
    },
  };
  return cell;
}

/**
 * An LTX file produced page by page, as celld writes it (block format: size-prefixed LZ4 page
 * blocks, page index, trailer, CRC-64/ISO over the uncompressed pages): the bytes come out as an
 * async stream while `pages` is consumed, so a writer holds one page at a time plus the index
 * (a few bytes per page), never the database.
 */
export async function* encodeLtxStream(
  header: LtxHeader,
  pages: AsyncIterable<[number, Uint8Array]>,
  postApplyChecksum = 0n,
  /** Filled while encoding: the file's page index (what `openLtxPages` would read back). */
  written?: { index: Map<number, [number, number]> },
): AsyncGenerator<Uint8Array> {
  // Coalesced into 256 KiB chunks: a writer pays per call (an OPFS SyncAccessHandle write, a
  // stream write), and a page makes three small pieces.
  yield* coalesce(encodePieces(header, pages, postApplyChecksum, written), 256 * 1024);
}

async function* coalesce(src: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  let buf = new Uint8Array(size);
  let n = 0;
  for await (const piece of src) {
    if (piece.length >= size) {
      if (n) yield buf.slice(0, n), (n = 0);
      yield piece;
      continue;
    }
    if (n + piece.length > size) {
      yield buf.slice(0, n);
      buf = new Uint8Array(size);
      n = 0;
    }
    buf.set(piece, n);
    n += piece.length;
  }
  if (n) yield buf.slice(0, n);
}

async function* encodePieces(
  header: LtxHeader,
  pages: AsyncIterable<[number, Uint8Array]>,
  postApplyChecksum: bigint,
  written?: { index: Map<number, [number, number]> },
): AsyncGenerator<Uint8Array> {
  const crc = new Crc64();
  const head = new Uint8Array(HEADER_SIZE);
  const v = new DataView(head.buffer);
  head.set(new TextEncoder().encode("LTX1"), 0);
  const flags =
    header.flags ?? (header.preApplyChecksum === 0n && postApplyChecksum === 0n ? 2 : 0);
  v.setUint32(4, flags);
  v.setUint32(8, header.pageSize);
  v.setUint32(12, header.commit);
  v.setBigUint64(16, header.minTXID);
  v.setBigUint64(24, header.maxTXID);
  v.setBigInt64(32, BigInt(header.timestamp));
  v.setBigUint64(40, header.preApplyChecksum);
  v.setBigUint64(72, header.nodeID ?? 0n);
  crc.update(head);
  yield head;
  const index: number[] = [];
  const uvarint = (n: number) => {
    while (n >= 0x80) index.push((n & 0x7f) | 0x80), (n = Math.floor(n / 128));
    index.push(n);
  };
  let offset = HEADER_SIZE;
  const lock = lockPgno(header.pageSize);
  let last = 0;
  for await (const [pgno, data] of pages) {
    if (pgno === lock) continue;
    if (pgno <= last) throw new Error("ltx: pages must come in ascending order");
    last = pgno;
    const compressed = lz4Compress(data);
    const ph = new Uint8Array(10);
    const pv = new DataView(ph.buffer);
    pv.setUint32(0, pgno);
    pv.setUint16(4, PAGE_HEADER_FLAG_SIZE);
    pv.setUint32(6, compressed.length);
    crc.update(ph).update(data); // the checksum covers uncompressed pages (encodeLtx's `feed`)
    uvarint(pgno), uvarint(offset), uvarint(10 + compressed.length);
    written?.index.set(pgno, [offset, 10 + compressed.length]);
    offset += 10 + compressed.length;
    yield ph;
    yield compressed;
  }
  const end = new Uint8Array(6);
  uvarint(0);
  const idx = Uint8Array.from(index);
  const tail = new Uint8Array(16);
  const tv = new DataView(tail.buffer);
  tv.setBigUint64(0, BigInt(idx.length));
  tv.setBigUint64(8, postApplyChecksum);
  crc.update(end).update(idx).update(tail);
  const sum = new Uint8Array(8);
  new DataView(sum.buffer).setBigUint64(0, CHECKSUM_FLAG | crc.digest());
  yield end;
  yield idx;
  yield tail;
  yield sum;
}

/**
 * Folds a cell's files into one snapshot (TXID 1..maxTXID) written to `files` at `path`, page by
 * page: each page is read by range from the file that holds it and streamed into the new file,
 * so memory stays at one page (plus the index), whatever the database size. The caller removes
 * the files it replaces once this resolves.
 */
export async function compactPagedCellTo(
  cell: PagedCell,
  files: FilesApi,
  path: string,
  timestamp = Date.now(),
): Promise<void> {
  // In runs of 256 pages: one range read per file a run touches (not one read per page).
  async function* pages(): AsyncGenerator<[number, Uint8Array]> {
    for (let from = 1; from <= cell.pageCount; from += 256) {
      const run = await cell.readRun(from, 256);
      for (let pgno = from; pgno < from + 256 && pgno <= cell.pageCount; pgno++)
        yield [pgno, run.get(pgno) ?? new Uint8Array(cell.pageSize)];
    }
  }
  await files.write(
    path,
    encodeLtxStream(
      {
        pageSize: cell.pageSize,
        commit: cell.pageCount,
        minTXID: 1n,
        maxTXID: cell.maxTXID,
        timestamp,
        preApplyChecksum: 0n,
      },
      pages(),
    ),
  );
}

/** The compacted snapshot as bytes (small cells, tests); compactPagedCellTo streams it. */
export async function compactPagedCell(
  cell: PagedCell,
  timestamp = Date.now(),
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  async function* pages(): AsyncGenerator<[number, Uint8Array]> {
    for (let pgno = 1; pgno <= cell.pageCount; pgno++) yield [pgno, await cell.readPage(pgno)];
  }
  for await (const c of encodeLtxStream(
    {
      pageSize: cell.pageSize,
      commit: cell.pageCount,
      minTXID: 1n,
      maxTXID: cell.maxTXID,
      timestamp,
      preApplyChecksum: 0n,
    },
    pages(),
  ))
    chunks.push(c);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) out.set(c, o), (o += c.length);
  return out;
}
