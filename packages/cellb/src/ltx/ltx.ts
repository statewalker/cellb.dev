import { crc64 } from "./crc64.js";
import { lz4Compress, lz4Decompress, lz4FrameCompress, lz4FrameDecompress } from "./lz4.js";

/**
 * LTX v3 (superfly/ltx v0.5.2), byte for byte as celld writes it — see
 * crates/ltx/reference/ltx-format.md in denoland/celld. Big-endian integers, 100-byte
 * header, size-prefixed LZ4 page blocks, page index, 16-byte trailer, CRC-64/ISO checksums
 * with the top bit always set.
 */
export const CHECKSUM_FLAG = 1n << 63n;
const HEADER_SIZE = 100;
const PAGE_HEADER_FLAG_SIZE = 1;

export interface LtxHeader {
  pageSize: number;
  /** Database size after the transaction, in pages. */
  commit: number;
  minTXID: bigint;
  maxTXID: bigint;
  timestamp: number;
  preApplyChecksum: bigint;
  nodeID?: bigint;
}

export interface LtxFile {
  header: LtxHeader;
  /** pgno → page bytes, ascending. */
  pages: Map<number, Uint8Array>;
  postApplyChecksum: bigint;
}

const be32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
const be64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, n));
  return b;
};
const uvarint = (n: number): number[] => {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
};

/** The SQLite lock page (never stored, excluded from checksums). */
export const lockPgno = (pageSize: number) => Math.floor(0x40000000 / pageSize) + 1;

export const checksumPage = (pgno: number, data: Uint8Array) => CHECKSUM_FLAG | crc64(be32(pgno), data);

/** Rolling database checksum over pages 1..n (lock page excluded). */
export function databaseChecksum(pageSize: number, pageAt: (pgno: number) => Uint8Array, n: number): bigint {
  const lock = lockPgno(pageSize);
  let sum = CHECKSUM_FLAG;
  for (let p = 1; p <= n; p++) if (p !== lock) sum = CHECKSUM_FLAG | (sum ^ checksumPage(p, pageAt(p)));
  return sum;
}

/** Offset just past the LZ4 frame starting at `o` (blocks up to the end mark, content checksum). */
function endOfFrame(b: Uint8Array, o: number): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const flg = b[o + 4];
  o += 6 + (flg & 0x08 ? 8 : 0) + (flg & 0x01 ? 4 : 0) + 1;
  for (;;) {
    const word = v.getUint32(o, true);
    o += 4;
    if (word === 0) break;
    o += (word & 0x7fffffff) + (flg & 0x10 ? 4 : 0);
  }
  return o + (flg & 0x04 ? 4 : 0);
}

/**
 * `format: "legacy"` (default) writes one LZ4 frame per page, as celld 0.6.2 does; `"block"`
 * writes v0.5.2's size-prefixed blocks (celld's decoder accepts both).
 */
export function encodeLtx(file: LtxFile, format: "legacy" | "block" = "legacy"): Uint8Array {
  const h = file.header;
  const header = new Uint8Array(HEADER_SIZE);
  const v = new DataView(header.buffer);
  header.set(new TextEncoder().encode("LTX1"), 0);
  v.setUint32(4, 0); // flags: checksums on
  v.setUint32(8, h.pageSize);
  v.setUint32(12, h.commit);
  v.setBigUint64(16, h.minTXID);
  v.setBigUint64(24, h.maxTXID);
  v.setBigInt64(32, BigInt(h.timestamp));
  v.setBigUint64(40, h.preApplyChecksum);
  // WAL offset/size/salts stay 0 (journal mode); node id:
  v.setBigUint64(72, h.nodeID ?? 0n);

  const out: Uint8Array[] = [header];
  const feed: Uint8Array[] = [header];
  const index: number[] = [];
  let offset = HEADER_SIZE;
  const lock = lockPgno(h.pageSize);
  for (const [pgno, data] of [...file.pages].sort((a, b) => a[0] - b[0])) {
    if (pgno === lock) continue;
    const ph = new Uint8Array(6);
    new DataView(ph.buffer).setUint32(0, pgno);
    if (format === "block") {
      new DataView(ph.buffer).setUint16(4, PAGE_HEADER_FLAG_SIZE);
      const compressed = lz4Compress(data);
      const size = be32(compressed.length);
      out.push(ph, size, compressed);
      feed.push(ph, size, data);
      index.push(...uvarint(pgno), ...uvarint(offset), ...uvarint(6 + 4 + compressed.length));
      offset += 6 + 4 + compressed.length;
    } else {
      const frame = lz4FrameCompress(data);
      out.push(ph, frame);
      feed.push(ph, data);
      index.push(...uvarint(pgno), ...uvarint(offset), ...uvarint(6 + frame.length));
      offset += 6 + frame.length;
    }
  }
  const empty = new Uint8Array(6);
  index.push(...uvarint(0));
  const idx = Uint8Array.from(index);
  const idxLen = be64(BigInt(idx.length));
  const post = be64(file.postApplyChecksum);
  out.push(empty, idx, idxLen);
  feed.push(empty, idx, idxLen, post);
  const fileChecksum = CHECKSUM_FLAG | crc64(...feed);
  out.push(post, be64(fileChecksum));
  const total = new Uint8Array(out.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of out) {
    total.set(b, o);
    o += b.length;
  }
  return total;
}

export function decodeLtx(bytes: Uint8Array): LtxFile {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "LTX1") throw new Error("ltx: bad magic");
  const flags = v.getUint32(4);
  const header: LtxHeader = {
    pageSize: v.getUint32(8),
    commit: v.getUint32(12),
    minTXID: v.getBigUint64(16),
    maxTXID: v.getBigUint64(24),
    timestamp: Number(v.getBigInt64(32)),
    preApplyChecksum: v.getBigUint64(40),
    nodeID: v.getBigUint64(72),
  };
  const feed: Uint8Array[] = [bytes.subarray(0, HEADER_SIZE)];
  const pages = new Map<number, Uint8Array>();
  let o = HEADER_SIZE;
  for (;;) {
    const pgno = v.getUint32(o);
    const pflags = v.getUint16(o + 4);
    feed.push(bytes.subarray(o, o + 6));
    o += 6;
    if (pgno === 0) break;
    let data: Uint8Array;
    if (pflags & PAGE_HEADER_FLAG_SIZE) {
      const size = v.getUint32(o);
      feed.push(bytes.subarray(o, o + 4));
      o += 4;
      data = lz4Decompress(bytes.subarray(o, o + size), header.pageSize);
      o += size;
    } else {
      // legacy (v0.5.1, what celld writes today): one LZ4 frame, its length found by parsing
      const start = o;
      o = endOfFrame(bytes, o);
      data = lz4FrameDecompress(bytes.subarray(start, o), header.pageSize);
    }
    feed.push(data);
    pages.set(pgno, data);
  }
  // page index: varints until 0, then u64 length
  const idxStart = o;
  for (;;) {
    let x = 0;
    let shift = 0;
    let b: number;
    do {
      b = bytes[o++];
      x += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    if (x === 0) break;
    for (let k = 0; k < 2; k++) do b = bytes[o++]; while (b & 0x80);
  }
  feed.push(bytes.subarray(idxStart, o + 8));
  o += 8;
  const postApplyChecksum = v.getBigUint64(o);
  const fileChecksum = v.getBigUint64(o + 8);
  feed.push(bytes.subarray(o, o + 8));
  if (!(flags & 2) && (CHECKSUM_FLAG | crc64(...feed)) !== fileChecksum)
    throw new Error("ltx: file checksum mismatch");
  return { header, pages, postApplyChecksum };
}

/** `<minTXID:016x>-<maxTXID:016x>.ltx` */
export const ltxFileName = (min: bigint, max: bigint) =>
  `${min.toString(16).padStart(16, "0")}-${max.toString(16).padStart(16, "0")}.ltx`;
