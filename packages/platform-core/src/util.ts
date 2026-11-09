import type { FileInfo, FilesApi } from "@statewalker/webrun-files";

export const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers as Record<string, string>),
    },
  });

export const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "*",
};

/**
 * Whether `request` may write or compute: always without a token configured, else with
 * `Authorization: Bearer <token>`. Reads (GET, HEAD, OPTIONS) are public, except the paths in
 * `privateReads` (a build's inputs are the user's sources).
 */
export function authorized(
  request: Request,
  token: string | undefined,
  privateRead = false,
): boolean {
  if (!token) return true;
  const read =
    request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
  if (read && !privateRead) return true;
  const got = request.headers.get("authorization") ?? "";
  const want = `Bearer ${token}`;
  // Constant time over the expected length.
  let diff = got.length ^ want.length;
  for (let i = 0; i < want.length; i++) diff |= (got.charCodeAt(i) || 0) ^ want.charCodeAt(i);
  return diff === 0;
}

export function withCors(res: Response): Response {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
  return r;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `files` seen from `prefix`: the view's paths are paths below it. */
/** `path` with `.` and `..` resolved, empty segments dropped, starting with "/". */
export function resolvePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/**
 * A path an upload names (a ZIP entry, a JSON key, a PUT): relative to the tree it lands in.
 * `..` segments, backslashes and NUL are refused, so an entry cannot reach outside its tree
 * (`../snap/<id>/index.html`).
 */
export function safeUploadPath(name: string): string {
  if (/[\\\0]/.test(name) || name.split("/").some((s) => s === ".."))
    throw new Error(`refused path ${JSON.stringify(name)}: no "..", backslashes or NUL`);
  return resolvePath(name);
}

export function subtree(files: FilesApi, prefix: string): FilesApi {
  const base = resolvePath(prefix).replace(/\/$/, "");
  // A path of the view never leaves the prefix: `..` is resolved inside the view first.
  const p = (path: string) => `${base}${resolvePath(path)}`.replace(/\/$/, "") || "/";
  const back = (info: FileInfo): FileInfo => ({
    ...info,
    path: info.path.slice(base.length) || "/",
  });
  return {
    read: (path, o) => files.read(p(path), o),
    write: (path, c) => files.write(p(path), c),
    mkdir: (path) => files.mkdir(p(path)),
    async *list(path, o) {
      for await (const info of files.list(p(path), o?.after ? { ...o, after: p(o.after) } : o))
        yield back(info);
    },
    stats: (path) => files.stats(p(path)),
    exists: (path) => files.exists(p(path)),
    remove: (path) => files.remove(p(path)),
    move: (a, b) => files.move(p(a), p(b)),
    copy: (a, b) => files.copy(p(a), p(b)),
  };
}

/** Every file path below `dir`, recursively. */
export async function listFiles(files: FilesApi, dir = "/"): Promise<string[]> {
  const out: string[] = [];
  for await (const e of files.list(dir, { recursive: true }))
    if (e.kind === "file") out.push(e.path);
  return out;
}

/** JSON with comments and trailing commas (wrangler.jsonc). */
export function parseJsonc(source: string): unknown {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < source.length) {
    const c = source[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += source[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
    } else if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i + 2);
      i = i < 0 ? source.length : i + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  wasm: "application/wasm",
  zip: "application/zip",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml",
};
export const mimeOf = (path: string) =>
  MIME[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

// ---------------------------------------------------------------------------------------------
// ZIP (stored entries, no compression): enough to ship a project in and a build out.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A ZIP of `files` (path → bytes), entries stored. */
/** Entries and sizes a stored ZIP without ZIP64 can name. */
const ZIP_MAX_ENTRIES = 0xffff;

export function zip(files: Map<string, Uint8Array> | [string, Uint8Array][]): Uint8Array {
  const list = [...files];
  if (list.length > ZIP_MAX_ENTRIES)
    throw new Error(`a ZIP holds at most ${ZIP_MAX_ENTRIES} files (no ZIP64)`);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let count = 0;
  for (const [rawPath, data] of list) {
    const name = enc.encode(rawPath.replace(/^\/+/, ""));
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
    count++;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, count, true);
  end.setUint16(10, count, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * A ZIP (entries stored) as a stream, reading one file at a time: memory stays at the largest
 * file, not the archive (an isolate's heap is a few hundred MB; a build's inputs can be 40 MB).
 */
export function zipStream(
  paths: string[],
  read: (path: string) => Promise<Uint8Array>,
): ReadableStream<Uint8Array> {
  if (paths.length > ZIP_MAX_ENTRIES)
    throw new Error(`a ZIP holds at most ${ZIP_MAX_ENTRIES} files (no ZIP64)`);
  const enc = new TextEncoder();
  const central: Uint8Array[] = [];
  let offset = 0;
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i < paths.length) {
        const rawPath = paths[i++];
        const data = await read(rawPath);
        const name = enc.encode(rawPath.replace(/^\/+/, ""));
        const crc = crc32(data);
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, name.length, true);
        controller.enqueue(new Uint8Array(local.buffer));
        controller.enqueue(name);
        controller.enqueue(data);
        const cd = new DataView(new ArrayBuffer(46));
        cd.setUint32(0, 0x02014b50, true);
        cd.setUint16(4, 20, true);
        cd.setUint16(6, 20, true);
        cd.setUint16(8, 0x0800, true);
        cd.setUint32(16, crc, true);
        cd.setUint32(20, data.length, true);
        cd.setUint32(24, data.length, true);
        cd.setUint16(28, name.length, true);
        cd.setUint32(42, offset, true);
        central.push(new Uint8Array(cd.buffer), name);
        offset += 30 + name.length + data.length;
        return;
      }
      const cdSize = central.reduce((n, p) => n + p.length, 0);
      for (const c of central) controller.enqueue(c);
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true);
      end.setUint16(8, paths.length, true);
      end.setUint16(10, paths.length, true);
      end.setUint32(12, cdSize, true);
      end.setUint32(16, offset, true);
      controller.enqueue(new Uint8Array(end.buffer));
      controller.close();
    },
  });
}

/** Entries of a ZIP (stored or deflated), path → bytes; directories are skipped. */
export interface UnzipLimits {
  /** Entries at most (default 20 000). */
  maxEntries?: number;
  /** Bytes of all entries once inflated, at most (default 256 MB): a deflate bomb stops here. */
  maxBytes?: number;
}

export async function unzip(
  bytes: Uint8Array,
  limits: UnzipLimits = {},
): Promise<Map<string, Uint8Array>> {
  try {
    return await unzipUnchecked(bytes, limits);
  } catch (e) {
    // A truncated or corrupt archive reads out of bounds: say so, not "Offset is outside".
    if (e instanceof RangeError) throw new Error("corrupt ZIP file");
    throw e;
  }
}

/** deflate-raw `data`, failing as soon as the output passes `max` bytes. */
async function inflateBounded(data: Uint8Array, max: number): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel();
      throw new Error("the ZIP inflates past its limit");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

async function unzipUnchecked(
  bytes: Uint8Array,
  limits: UnzipLimits,
): Promise<Map<string, Uint8Array>> {
  const maxEntries = limits.maxEntries ?? 20_000;
  const maxBytes = limits.maxBytes ?? 256_000_000;
  let total = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("not a ZIP file");
  const count = view.getUint16(eocd + 10, true);
  if (count > maxEntries) throw new Error(`the ZIP has ${count} entries; at most ${maxEntries}`);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const path = safeUploadPath(name);
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    if (start + csize > bytes.length) throw new RangeError("entry past the end");
    const data = bytes.subarray(start, start + csize);
    // Declared sizes first, then what really inflates (a header can lie).
    if (total + Math.max(usize, csize) > maxBytes)
      throw new Error(`the ZIP inflates past ${maxBytes} bytes`);
    if (method === 0) {
      total += csize;
      out.set(path, data.slice());
    } else if (method === 8) {
      const inflated = await inflateBounded(data, maxBytes - total);
      total += inflated.length;
      out.set(path, inflated);
    } else throw new Error(`unsupported ZIP method ${method} for ${name}`);
  }
  return out;
}

/** A project upload: a ZIP body, or JSON `{ files: { "<path>": "<text>" } }` (`base64:` prefix for bytes). */
export async function readUpload(request: Request): Promise<Map<string, Uint8Array>> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    const { files = {} } = (await request.json()) as { files?: Record<string, string> };
    const enc = new TextEncoder();
    const out = new Map<string, Uint8Array>();
    for (const [p, v] of Object.entries(files)) {
      const path = safeUploadPath(p);
      out.set(
        path,
        v.startsWith("base64:")
          ? Uint8Array.from(atob(v.slice(7)), (c) => c.charCodeAt(0))
          : enc.encode(v),
      );
    }
    return out;
  }
  return unzip(new Uint8Array(await request.arrayBuffer()));
}
