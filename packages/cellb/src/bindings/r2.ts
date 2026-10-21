import { md5 } from "@noble/hashes/legacy";
import { bytesToHex } from "@noble/hashes/utils";
import type { FilesApi } from "@statewalker/webrun-files";

/**
 * The R2 binding (`env.BUCKET.get/put/head/delete/list`) on a webrun-files FilesApi.
 * Like celld — whose R2 bindings read and write objects directly in the fleet bucket,
 * not through a cell — objects live in the store as files:
 *   {root}/objects/<encoded key>      the bytes
 *   {root}/meta/<encoded key>.json    key, size, etag (MD5), version, uploaded, metadata
 * Multipart uploads and conditional requests (onlyIf) are not implemented yet.
 */
export interface R2HTTPMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

interface StoredMeta {
  key: string;
  size: number;
  etag: string;
  version: string;
  uploaded: number;
  httpMetadata: R2HTTPMetadata;
  customMetadata: Record<string, string>;
}

export class R2Object {
  readonly key: string;
  readonly version: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly uploaded: Date;
  readonly httpMetadata: R2HTTPMetadata;
  readonly customMetadata: Record<string, string>;
  readonly checksums: { md5?: ArrayBuffer };
  readonly storageClass = "Standard";
  readonly range?: { offset: number; length: number };
  constructor(m: StoredMeta, range?: { offset: number; length: number }) {
    this.key = m.key;
    this.version = m.version;
    this.size = m.size;
    this.etag = m.etag;
    this.httpEtag = `"${m.etag}"`;
    this.uploaded = new Date(m.uploaded);
    this.httpMetadata = { ...m.httpMetadata };
    this.customMetadata = { ...m.customMetadata };
    const bytes = m.etag.match(/../g)?.map((h) => Number.parseInt(h, 16)) ?? [];
    this.checksums = { md5: new Uint8Array(bytes).buffer };
    if (range) this.range = range;
  }
  writeHttpMetadata(headers: Headers): void {
    const h = this.httpMetadata;
    if (h.contentType) headers.set("content-type", h.contentType);
    if (h.contentLanguage) headers.set("content-language", h.contentLanguage);
    if (h.contentDisposition) headers.set("content-disposition", h.contentDisposition);
    if (h.contentEncoding) headers.set("content-encoding", h.contentEncoding);
    if (h.cacheControl) headers.set("cache-control", h.cacheControl);
    if (h.cacheExpiry) headers.set("expires", new Date(h.cacheExpiry).toUTCString());
  }
}

export class R2ObjectBody extends R2Object {
  readonly #bytes: Uint8Array;
  #used = false;
  constructor(m: StoredMeta, bytes: Uint8Array, range?: { offset: number; length: number }) {
    super(m, range);
    this.#bytes = bytes;
  }
  get bodyUsed(): boolean {
    return this.#used;
  }
  get body(): ReadableStream<Uint8Array> {
    this.#used = true;
    const bytes = this.#bytes;
    return new ReadableStream({
      start(c) {
        c.enqueue(bytes.slice());
        c.close();
      },
    });
  }
  #take(): Uint8Array {
    if (this.#used) throw new TypeError("Body has already been used");
    this.#used = true;
    return this.#bytes;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    const b = this.#take();
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }
  async bytes(): Promise<Uint8Array> {
    return this.#take().slice();
  }
  async text(): Promise<string> {
    return new TextDecoder().decode(this.#take());
  }
  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }
  async blob(): Promise<Blob> {
    return new Blob([this.#take() as BlobPart], { type: this.httpMetadata.contentType ?? "" });
  }
}

export type R2PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null;

export interface R2ListOptions {
  limit?: number;
  prefix?: string;
  cursor?: string;
  delimiter?: string;
  startAfter?: string;
  include?: ("httpMetadata" | "customMetadata")[];
}

const enc = (key: string) => encodeURIComponent(key);

async function readAll(files: FilesApi, path: string): Promise<Uint8Array | undefined> {
  if (!(await files.exists(path))) return undefined;
  const chunks: Uint8Array[] = [];
  for await (const c of files.read(path)) chunks.push(c);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

async function toBytes(value: R2PutValue): Promise<Uint8Array> {
  if (value === null) return new Uint8Array();
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value))
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  return new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
}

function httpMetadataOf(input: R2HTTPMetadata | Headers | undefined): R2HTTPMetadata {
  if (!input) return {};
  if (input instanceof Headers) {
    const m: R2HTTPMetadata = {};
    const map: [keyof R2HTTPMetadata, string][] = [
      ["contentType", "content-type"],
      ["contentLanguage", "content-language"],
      ["contentDisposition", "content-disposition"],
      ["contentEncoding", "content-encoding"],
      ["cacheControl", "cache-control"],
    ];
    for (const [k, h] of map) {
      const v = input.get(h);
      if (v !== null) (m as Record<string, string>)[k] = v;
    }
    const expires = input.get("expires");
    if (expires) m.cacheExpiry = new Date(expires);
    return m;
  }
  return { ...input };
}

/** R2 conditional request: an object or the equivalent HTTP headers. */
export interface R2Conditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
  uploadedBefore?: Date;
  uploadedAfter?: Date;
  secondsGranularity?: boolean;
}

function conditionOf(onlyIf: R2Conditional | Headers | undefined): R2Conditional | undefined {
  if (!(onlyIf instanceof Headers)) return onlyIf;
  const unquote = (v: string | null) =>
    v?.replace(/^W\//, "").replace(/^"(.*)"$/, "$1") ?? undefined;
  const date = (v: string | null) => (v ? new Date(v) : undefined);
  return {
    etagMatches: unquote(onlyIf.get("if-match")),
    etagDoesNotMatch: unquote(onlyIf.get("if-none-match")),
    uploadedBefore: date(onlyIf.get("if-unmodified-since")),
    uploadedAfter: date(onlyIf.get("if-modified-since")),
    secondsGranularity: true,
  };
}

/** Evaluates a conditional against a stored object (no object: only etagMatches fails). */
function conditionHolds(c: R2Conditional | undefined, m: StoredMeta | undefined): boolean {
  if (!c) return true;
  const etagIn = (list: string) => list.split(",").map((e) => e.trim().replace(/^"(.*)"$/, "$1"));
  if (
    c.etagMatches !== undefined &&
    (!m || !(c.etagMatches === "*" || etagIn(c.etagMatches).includes(m.etag)))
  )
    return false;
  if (
    c.etagDoesNotMatch !== undefined &&
    m &&
    (c.etagDoesNotMatch === "*" || etagIn(c.etagDoesNotMatch).includes(m.etag))
  )
    return false;
  if (m) {
    const t = c.secondsGranularity ? Math.floor(m.uploaded / 1000) * 1000 : m.uploaded;
    if (c.uploadedBefore && !(t < new Date(c.uploadedBefore).getTime())) return false;
    if (c.uploadedAfter && !(t > new Date(c.uploadedAfter).getTime())) return false;
  }
  return true;
}

export function r2Bucket(files: FilesApi, root: string) {
  const objectPath = (key: string) => `${root}/objects/${enc(key)}`;
  const metaPath = (key: string) => `${root}/meta/${enc(key)}.json`;
  const readMeta = async (key: string): Promise<StoredMeta | undefined> => {
    const raw = await readAll(files, metaPath(key));
    return raw ? (JSON.parse(new TextDecoder().decode(raw)) as StoredMeta) : undefined;
  };
  const checkKey = (key: string) => {
    if (typeof key !== "string" || key.length === 0)
      throw new TypeError("R2 key must be a non-empty string");
    if (new TextEncoder().encode(key).byteLength > 1024)
      throw new TypeError("R2 key is longer than 1024 bytes");
  };

  return {
    async head(key: string): Promise<R2Object | null> {
      checkKey(key);
      const m = await readMeta(key);
      return m ? new R2Object(m) : null;
    },

    async get(
      key: string,
      options: {
        range?: { offset?: number; length?: number; suffix?: number } | Headers;
        onlyIf?: R2Conditional | Headers;
      } = {},
    ): Promise<R2ObjectBody | R2Object | null> {
      checkKey(key);
      const m = await readMeta(key);
      if (!m) return null;
      // A failed condition returns the object's metadata without a body.
      if (!conditionHolds(conditionOf(options.onlyIf), m)) return new R2Object(m);
      const bytes = (await readAll(files, objectPath(key))) ?? new Uint8Array();
      let r = options.range;
      if (r instanceof Headers) {
        const h = /^bytes=(\d*)-(\d*)$/.exec(r.get("range") ?? "");
        r = h
          ? h[1] === ""
            ? { suffix: Number(h[2]) }
            : {
                offset: Number(h[1]),
                length: h[2] === "" ? undefined : Number(h[2]) - Number(h[1]) + 1,
              }
          : undefined;
      }
      // A full read reports the whole object as its range (workerd/celld behaviour).
      if (!r) return new R2ObjectBody(m, bytes, { offset: 0, length: bytes.byteLength });
      const offset =
        r.suffix !== undefined ? Math.max(0, bytes.byteLength - r.suffix) : (r.offset ?? 0);
      const length =
        r.suffix !== undefined
          ? bytes.byteLength - offset
          : (r.length ?? bytes.byteLength - offset);
      return new R2ObjectBody(m, bytes.slice(offset, offset + length), { offset, length });
    },

    async put(
      key: string,
      value: R2PutValue,
      options: {
        httpMetadata?: R2HTTPMetadata | Headers;
        customMetadata?: Record<string, string>;
        md5?: string | ArrayBuffer;
        onlyIf?: R2Conditional | Headers;
      } = {},
    ): Promise<R2Object | null> {
      checkKey(key);
      // A refused condition stores nothing and returns null.
      if (options.onlyIf && !conditionHolds(conditionOf(options.onlyIf), await readMeta(key)))
        return null;
      const bytes = await toBytes(value);
      const etag = bytesToHex(md5(bytes));
      if (options.md5 !== undefined) {
        const expected =
          typeof options.md5 === "string" ? options.md5 : bytesToHex(new Uint8Array(options.md5));
        if (expected.toLowerCase() !== etag)
          throw new Error("put: The Content-MD5 you specified did not match what we received.");
      }
      const meta: StoredMeta = {
        key,
        size: bytes.byteLength,
        etag,
        version: crypto.randomUUID().replace(/-/g, ""),
        uploaded: Date.now(),
        httpMetadata: httpMetadataOf(options.httpMetadata),
        customMetadata: { ...options.customMetadata },
      };
      await files.write(objectPath(key), [bytes]);
      await files.write(metaPath(key), [new TextEncoder().encode(JSON.stringify(meta))]);
      return new R2Object(meta);
    },

    async createMultipartUpload(
      key: string,
      options: {
        httpMetadata?: R2HTTPMetadata | Headers;
        customMetadata?: Record<string, string>;
      } = {},
    ) {
      checkKey(key);
      const uploadId = crypto.randomUUID().replace(/-/g, "");
      await files.write(`${root}/multipart/${uploadId}/upload.json`, [
        new TextEncoder().encode(
          JSON.stringify({
            key,
            httpMetadata: httpMetadataOf(options.httpMetadata),
            customMetadata: options.customMetadata ?? {},
          }),
        ),
      ]);
      return this.resumeMultipartUpload(key, uploadId);
    },

    /** A handle on an open upload; parts live under {root}/multipart/{uploadId}/ until complete or abort. */
    resumeMultipartUpload(key: string, uploadId: string) {
      const dir = `${root}/multipart/${uploadId}`;
      const bucket = this;
      const info = async () => {
        const raw = await readAll(files, `${dir}/upload.json`);
        if (!raw)
          throw new Error(
            "completeMultipartUpload: The specified multipart upload does not exist. (10024)",
          );
        return JSON.parse(new TextDecoder().decode(raw)) as {
          key: string;
          httpMetadata: R2HTTPMetadata;
          customMetadata: Record<string, string>;
        };
      };
      return {
        key,
        uploadId,
        async uploadPart(partNumber: number, value: R2PutValue) {
          if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000)
            throw new Error("uploadPart: part number must be between 1 and 10000");
          await info();
          const bytes = await toBytes(value);
          const etag = bytesToHex(md5(bytes));
          await files.write(`${dir}/${String(partNumber).padStart(5, "0")}.part`, [bytes]);
          return { partNumber, etag };
        },
        async abort() {
          await files.remove(dir);
        },
        async complete(parts: { partNumber: number; etag: string }[]) {
          const u = await info();
          const chunks: Uint8Array[] = [];
          for (const p of parts) {
            const bytes = await readAll(
              files,
              `${dir}/${String(p.partNumber).padStart(5, "0")}.part`,
            );
            if (!bytes || bytesToHex(md5(bytes)) !== p.etag)
              throw new Error(
                `completeMultipartUpload: There was a problem with the multipart upload. (10025)`,
              );
            chunks.push(bytes);
          }
          const total = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
          let o = 0;
          for (const c of chunks) {
            total.set(c, o);
            o += c.byteLength;
          }
          const obj = (await bucket.put(u.key, total, {
            httpMetadata: u.httpMetadata,
            customMetadata: u.customMetadata,
          })) as R2Object;
          await files.remove(dir);
          return obj;
        },
      };
    },

    async delete(keys: string | string[]): Promise<void> {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        checkKey(key);
        await files.remove(metaPath(key));
        await files.remove(objectPath(key));
      }
    },

    async list(options: R2ListOptions = {}) {
      const limit = Math.min(Math.max(options.limit ?? 1000, 1), 1000);
      const keys: string[] = [];
      if (await files.exists(`${root}/meta`))
        for await (const f of files.list(`${root}/meta`)) {
          const name = f.path.split("/").pop() ?? "";
          if (f.kind === "file" && name.endsWith(".json"))
            keys.push(decodeURIComponent(name.slice(0, -5)));
        }
      keys.sort();
      const after = options.cursor ?? options.startAfter;
      const prefixes = new Set<string>();
      const objects: R2Object[] = [];
      let last: string | undefined;
      let truncated = false;
      for (const key of keys) {
        if (options.prefix && !key.startsWith(options.prefix)) continue;
        if (after !== undefined && key <= after) continue;
        if (options.delimiter) {
          const rest = key.slice(options.prefix?.length ?? 0);
          const i = rest.indexOf(options.delimiter);
          if (i >= 0) {
            prefixes.add((options.prefix ?? "") + rest.slice(0, i + options.delimiter.length));
            continue;
          }
        }
        if (objects.length === limit) {
          truncated = true;
          break;
        }
        const m = await readMeta(key);
        if (!m) continue;
        const include = options.include ?? [];
        if (!include.includes("httpMetadata")) m.httpMetadata = {};
        if (!include.includes("customMetadata")) m.customMetadata = {};
        objects.push(new R2Object(m));
        last = key;
      }
      return {
        objects,
        truncated,
        cursor: truncated ? last : undefined,
        delimitedPrefixes: [...prefixes].sort(),
      };
    },
  };
}
