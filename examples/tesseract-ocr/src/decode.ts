/**
 * PNG and JPEG decoding in plain JavaScript: Workers have no canvas, no
 * ImageBitmap and no ImageData, and tesseract-wasm only needs
 * `{ data, width, height }` with 4 bytes per pixel.
 *
 * Memory is the tight resource (128 MB per isolate, wasm included), so an
 * image is kept in its compact decoded form (a 1-bit scan of a letter page is
 * about 1 MB; its RGBA would be 34 MB) and expanded to RGBA one band of rows
 * at a time (`rows`), flattened onto white.
 */
import { decode as decodePng } from "fast-png";
import jpeg from "jpeg-js";

export type Rgba = { data: Uint8ClampedArray; width: number; height: number };

/** A decoded image that hands out RGBA rows on demand. */
export type PixelSource = {
  width: number;
  height: number;
  /** Bytes held by the compact decoded image. */
  bytes: number;
  /** Rows [y0, y1) as RGBA, transparency flattened onto white. */
  rows(y0: number, y1: number): Rgba;
};

/** Images above this many pixels are refused before decoding (memory, see README). */
export const MAX_PIXELS = 40_000_000;

export function sniff(bytes: Uint8Array): "png" | "jpeg" | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  return null;
}

/** Encoded bytes (PNG, JPEG) or raw pixels, as a pixel source. */
export function toSource(image: ArrayBuffer | Uint8Array | RawImage): PixelSource {
  if (image instanceof ArrayBuffer) return decodeImage(new Uint8Array(image));
  if (image instanceof Uint8Array) return decodeImage(image);
  return rawSource(image);
}

export function decodeImage(bytes: Uint8Array): PixelSource {
  const kind = sniff(bytes);
  if (kind === "jpeg") return jpegSource(bytes);
  if (kind === "png") return pngSource(bytes);
  throw new Error("EINVAL: not a PNG or JPEG image");
}

/** The whole image as RGBA (small images, tests). */
export const toRgba = (source: PixelSource): Rgba => source.rows(0, source.height);

/** Writes one pixel, flattened onto white. */
function put(out: Uint8ClampedArray, o: number, r: number, g: number, b: number, a: number) {
  if (a === 255) {
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
  } else {
    const k = a / 255;
    out[o] = r * k + 255 * (1 - k);
    out[o + 1] = g * k + 255 * (1 - k);
    out[o + 2] = b * k + 255 * (1 - k);
  }
  out[o + 3] = 255;
}

function jpegSource(bytes: Uint8Array): PixelSource {
  // RGB, not RGBA: a quarter less to hold.
  const img = jpeg.decode(bytes, {
    useTArray: true,
    formatAsRGBA: false,
    maxResolutionInMP: MAX_PIXELS / 1e6,
    maxMemoryUsageInMB: 96,
  });
  const { width, height, data } = img;
  return {
    width,
    height,
    bytes: data.byteLength,
    rows(y0, y1) {
      const out = new Uint8ClampedArray(width * (y1 - y0) * 4);
      for (let p = 0, i = y0 * width * 3; p < out.length; p += 4, i += 3) {
        out[p] = data[i];
        out[p + 1] = data[i + 1];
        out[p + 2] = data[i + 2];
        out[p + 3] = 255;
      }
      return { data: out, width, height: y1 - y0 };
    },
  };
}

/**
 * The size a PNG declares in its IHDR, read before decoding: a small file can inflate to
 * gigabytes (a decompression bomb), so the pixel limit must hold before fast-png allocates.
 */
function pngDeclaredSize(bytes: Uint8Array): { width: number; height: number } {
  const tag = String.fromCharCode(...bytes.subarray(12, 16));
  if (bytes.byteLength < 24 || tag !== "IHDR") throw new Error("EINVAL: not a PNG (no IHDR)");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function pngSource(bytes: Uint8Array): PixelSource {
  const declared = pngDeclaredSize(bytes);
  if (declared.width * declared.height > MAX_PIXELS)
    throw new Error(`E2BIG: ${declared.width}×${declared.height} is too large`);
  const png = decodePng(bytes);
  const { width, height, depth } = png;
  if (width * height > MAX_PIXELS) throw new Error(`E2BIG: ${width}×${height} is too large`);
  const src = png.data;

  // Palette: indices stay packed; each row is looked up when asked for.
  if (png.palette) {
    const palette = png.palette.map((c) => [c[0], c[1], c[2], c[3] ?? 255]);
    const rowBytes = Math.ceil((width * depth) / 8);
    const mask = 2 ** depth - 1;
    return {
      width,
      height,
      bytes: src.byteLength,
      rows(y0, y1) {
        const out = new Uint8ClampedArray(width * (y1 - y0) * 4);
        for (let y = y0; y < y1; y++) {
          for (let x = 0; x < width; x++) {
            const index =
              depth === 8
                ? src[y * rowBytes + x]
                : (src[y * rowBytes + ((x * depth) >> 3)] >> (8 - depth - ((x * depth) & 7))) &
                  mask;
            const c = palette[index] ?? [0, 0, 0, 255];
            put(out, ((y - y0) * width + x) * 4, c[0], c[1], c[2], c[3]);
          }
        }
        return { data: out, width, height: y1 - y0 };
      },
    };
  }

  const channels = png.channels;
  if (depth < 8) {
    // Gray at 1, 2 or 4 bits: packed, rows padded to whole bytes.
    const rowBytes = Math.ceil((width * depth) / 8);
    const max = 2 ** depth - 1;
    return {
      width,
      height,
      bytes: src.byteLength,
      rows(y0, y1) {
        const out = new Uint8ClampedArray(width * (y1 - y0) * 4);
        for (let y = y0; y < y1; y++) {
          for (let x = 0; x < width; x++) {
            const bit = x * depth;
            const v = (src[y * rowBytes + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
            const g = Math.round((v / max) * 255);
            put(out, ((y - y0) * width + x) * 4, g, g, g, 255);
          }
        }
        return { data: out, width, height: y1 - y0 };
      },
    };
  }

  const shift = depth === 16 ? 8 : 0;
  return {
    width,
    height,
    bytes: src.byteLength,
    rows(y0, y1) {
      const out = new Uint8ClampedArray(width * (y1 - y0) * 4);
      for (let p = y0 * width, o = 0; p < y1 * width; p++, o += 4) {
        const i = p * channels;
        if (channels <= 2) {
          const g = src[i] >> shift;
          put(out, o, g, g, g, channels === 2 ? src[i + 1] >> shift : 255);
        } else {
          put(
            out,
            o,
            src[i] >> shift,
            src[i + 1] >> shift,
            src[i + 2] >> shift,
            channels === 4 ? src[i + 3] >> shift : 255,
          );
        }
      }
      return { data: out, width, height: y1 - y0 };
    },
  };
}

/**
 * Raw pixels as pdf.js hands them out without canvas (`kind` 1: 1-bit gray, packed rows,
 * 1 = white; 2: RGB; 3: RGBA), or a stencil mask (packed rows, 0 = painted black, 1 = clear).
 */
export type RawImage = {
  width: number;
  height: number;
  kind?: number;
  data: Uint8Array | Uint8ClampedArray;
  stencil?: boolean;
};

export function rawSource(raw: RawImage): PixelSource {
  const { width, height, data } = raw;
  if (width * height > MAX_PIXELS) throw new Error(`E2BIG: ${width}×${height} is too large`);
  const packed = raw.stencil || raw.kind === 1;
  const channels = packed ? 0 : raw.kind === 2 ? 3 : 4;
  const expected = packed ? ((width + 7) >> 3) * height : width * height * channels;
  if (data.length < expected) throw new Error("EINVAL: raw image data is too short");
  const rowBytes = (width + 7) >> 3;
  return {
    width,
    height,
    bytes: data.byteLength,
    rows(y0, y1) {
      const out = new Uint8ClampedArray(width * (y1 - y0) * 4);
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < width; x++) {
          const o = ((y - y0) * width + x) * 4;
          if (packed) {
            // Gray at 1 bpp: 1 is white. Stencil: 0 is painted, so black on white too.
            const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
            out[o] = out[o + 1] = out[o + 2] = bit ? 255 : 0;
            out[o + 3] = 255;
          } else {
            const i = (y * width + x) * channels;
            put(out, o, data[i], data[i + 1], data[i + 2], channels === 4 ? data[i + 3] : 255);
          }
        }
      }
      return { data: out, width, height: y1 - y0 };
    },
  };
}
