import { xxh32 } from "./xxh32.js";

/**
 * LZ4 block format (raw blocks, no frame): a standard decoder, and a simple greedy encoder
 * with a 4-byte hash table. Any valid block decodes the same, so LTX checksums (computed on
 * uncompressed pages) do not depend on the encoder's choices.
 */
export function lz4Decompress(src: Uint8Array, outSize: number, partial = false): Uint8Array {
  const out = new Uint8Array(outSize);
  let si = 0;
  let di = 0;
  while (si < src.length) {
    const token = src[si++];
    let lit = token >>> 4;
    if (lit === 15) {
      let b: number;
      do {
        b = src[si++];
        lit += b;
      } while (b === 255);
    }
    out.set(src.subarray(si, si + lit), di);
    si += lit;
    di += lit;
    if (si >= src.length) break; // last sequence has literals only
    const offset = src[si] | (src[si + 1] << 8);
    si += 2;
    let len = (token & 15) + 4;
    if ((token & 15) === 15) {
      let b: number;
      do {
        b = src[si++];
        len += b;
      } while (b === 255);
    }
    if (offset === 0 || offset > di) throw new Error("lz4: bad match offset");
    for (let i = 0; i < len; i++, di++) out[di] = out[di - offset];
  }
  if (!partial && di !== outSize) throw new Error(`lz4: decoded ${di} bytes, expected ${outSize}`);
  return partial ? out.subarray(0, di) : out;
}

export function lz4Compress(src: Uint8Array): Uint8Array {
  const n = src.length;
  const out = new Uint8Array(n + Math.ceil(n / 255) + 16);
  const table = new Int32Array(1 << 14).fill(-1);
  const hash = (i: number) =>
    (Math.imul(src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24), 2654435761) >>>
      18) &
    0x3fff;
  let si = 0;
  let di = 0;
  let anchor = 0;
  const writeLen = (len: number) => {
    while (len >= 255) {
      out[di++] = 255;
      len -= 255;
    }
    out[di++] = len;
  };
  const LAST_LITERALS = 5;
  const MF_LIMIT = 12;
  while (si + MF_LIMIT < n) {
    const h = hash(si);
    const ref = table[h];
    table[h] = si;
    if (
      ref >= 0 &&
      si - ref <= 0xffff &&
      src[ref] === src[si] &&
      src[ref + 1] === src[si + 1] &&
      src[ref + 2] === src[si + 2] &&
      src[ref + 3] === src[si + 3]
    ) {
      let len = 4;
      while (si + len < n - LAST_LITERALS && src[ref + len] === src[si + len]) len++;
      const lit = si - anchor;
      const tokenPos = di++;
      out[tokenPos] = (Math.min(lit, 15) << 4) | Math.min(len - 4, 15);
      if (lit >= 15) writeLen(lit - 15);
      out.set(src.subarray(anchor, si), di);
      di += lit;
      const off = si - ref;
      out[di++] = off & 0xff;
      out[di++] = off >>> 8;
      if (len - 4 >= 15) writeLen(len - 4 - 15);
      si += len;
      anchor = si;
    } else si++;
  }
  const lit = n - anchor;
  out[di++] = Math.min(lit, 15) << 4;
  if (lit >= 15) writeLen(lit - 15);
  out.set(src.subarray(anchor), di);
  di += lit;
  return out.slice(0, di);
}

/**
 * LZ4 frames as superfly/ltx v0.5.1 writes them (celld's current page format): magic,
 * FLG 0x64 (v1, independent blocks, content checksum), BD 0x40 (64 KiB blocks), header
 * checksum, data blocks, end mark, xxHash32 of the content.
 */
const FRAME_MAGIC = 0x184d2204;

export function lz4FrameDecompress(src: Uint8Array, outSize: number): Uint8Array {
  const v = new DataView(src.buffer, src.byteOffset, src.byteLength);
  if (v.getUint32(0, true) !== FRAME_MAGIC) throw new Error("lz4: bad frame magic");
  const flg = src[4];
  let o = 6 + (flg & 0x08 ? 8 : 0) + (flg & 0x01 ? 4 : 0) + 1; // FLG BD [size] [dict] HC
  const out = new Uint8Array(outSize);
  let di = 0;
  for (;;) {
    const word = v.getUint32(o, true);
    o += 4;
    if (word === 0) break;
    const size = word & 0x7fffffff;
    const block = src.subarray(o, o + size);
    o += size + (flg & 0x10 ? 4 : 0);
    if (word & 0x80000000) {
      out.set(block, di);
      di += size;
    } else {
      const part = lz4Decompress(block, Math.min(65536, outSize - di), true);
      out.set(part, di);
      di += part.length;
    }
  }
  if (flg & 0x04 && v.getUint32(o, true) !== xxh32(out))
    throw new Error("lz4: frame content checksum mismatch");
  return out;
}

export function lz4FrameCompress(data: Uint8Array): Uint8Array {
  const descriptor = Uint8Array.of(0x64, 0x40);
  const hc = (xxh32(descriptor) >>> 8) & 0xff;
  const block = lz4Compress(data);
  const raw = block.length >= data.length; // store uncompressed when it does not shrink
  const body = raw ? data : block;
  const out = new Uint8Array(4 + 3 + 4 + body.length + 4 + 4);
  const v = new DataView(out.buffer);
  v.setUint32(0, FRAME_MAGIC, true);
  out.set(descriptor, 4);
  out[6] = hc;
  v.setUint32(7, (body.length | (raw ? 0x80000000 : 0)) >>> 0, true);
  out.set(body, 11);
  v.setUint32(11 + body.length, 0, true);
  v.setUint32(15 + body.length, xxh32(data), true);
  return out;
}
