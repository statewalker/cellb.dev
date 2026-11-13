// Vendored from statewalker-sandbox/apps/flue-capfs-do (2641939, 2026-11-11); changes marked "studio:".
// Strings and bytes in the encodings file APIs take (Node's BufferEncoding, as just-bash uses
// it): "utf8" text, "latin1"/"binary" (one char per byte), "ascii", "base64" and "hex".

export type Encoding =
  | "utf8"
  | "utf-8"
  | "ascii"
  | "binary"
  | "latin1"
  | "base64"
  | "base64url"
  | "hex";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

const norm = (e: unknown) => String(e ?? "utf8").toLowerCase();

/** The encoding named by an option: a string, or `{ encoding }`. */
export function encodingOf(o: unknown): string | undefined {
  if (typeof o === "string") return o;
  if (o && typeof o === "object" && "encoding" in o) {
    const e = (o as { encoding?: unknown }).encoding;
    return e == null ? undefined : String(e);
  }
  return undefined;
}

export const isUtf8 = (e: unknown) => {
  const n = norm(e);
  return n === "utf8" || n === "utf-8";
};

/**
 * Exactly a view's bytes, for sending over RPC: structured clone copies a view's whole
 * ArrayBuffer, so a small view of a large buffer (a wasm heap, a pooled Buffer) is copied out.
 */
export const ownBytes = (b: Uint8Array): Uint8Array =>
  b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : b.slice();

/** Base64 as Node decodes it: URL-safe characters too, anything else skipped, no padding needed. */
export function fromBase64(s: string): Uint8Array {
  let clean = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/[^A-Za-z0-9+/]/g, "");
  if (clean.length % 4 === 1) clean = clean.slice(0, -1);
  clean += "=".repeat((4 - (clean.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  } catch {
    throw Object.assign(new Error("EINVAL: invalid base64"), { code: "EINVAL" });
  }
}

/** Bytes of a Uint8Array, any ArrayBuffer view or an ArrayBuffer; undefined for anything else. */
export function asBytes(d: unknown): Uint8Array | undefined {
  if (d instanceof Uint8Array) return d;
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  return undefined;
}

/** A string in `encoding` as the bytes it stands for. */
export function stringToBytes(s: string, encoding?: unknown): Uint8Array {
  switch (norm(encoding)) {
    case "utf8":
    case "utf-8":
      return enc.encode(s);
    case "latin1":
    case "binary":
      return Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
    case "ascii": // Node encodes ascii as latin1 (it masks only when decoding)
      return Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
    case "base64":
    case "base64url":
      return fromBase64(s);
    case "hex": {
      const out: number[] = [];
      for (let i = 0; i + 1 < s.length; i += 2) {
        const pair = s.slice(i, i + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(pair)) break;
        out.push(Number.parseInt(pair, 16));
      }
      return Uint8Array.from(out);
    }
    default:
      throw Object.assign(new Error(`EINVAL: unknown encoding '${String(encoding)}'`), {
        code: "EINVAL",
      });
  }
}

/** Bytes as a string in `encoding`. */
export function bytesToString(b: Uint8Array, encoding?: unknown): string {
  switch (norm(encoding)) {
    case "utf8":
    case "utf-8":
      return dec.decode(b);
    case "latin1":
    case "binary": {
      let s = "";
      for (let i = 0; i < b.length; i += 0x8000)
        s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return s;
    }
    case "ascii": {
      let s = "";
      for (let i = 0; i < b.length; i += 0x8000)
        s += String.fromCharCode(...Array.from(b.subarray(i, i + 0x8000), (x) => x & 0x7f));
      return s;
    }
    case "base64":
      return btoa(bytesToString(b, "latin1"));
    case "base64url":
      return btoa(bytesToString(b, "latin1"))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    case "hex":
      return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    default:
      throw Object.assign(new Error(`EINVAL: unknown encoding '${String(encoding)}'`), {
        code: "EINVAL",
      });
  }
}
