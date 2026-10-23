import type { ObjectAttributes, ObjectStore } from "../bucket/object-store.js";
import type { R2Backend, R2HTTPMetadata, StoredMeta } from "./r2.js";

/**
 * R2 objects as celld stores them (celld/r2_store.rs): not in a cell but directly in the fleet
 * bucket, one object per R2 object at `r2/<bucket_name>/<key>`. The five content headers are
 * stored as the object's own headers; everything else R2 has — case-sensitive custom metadata,
 * cacheExpiry, checksums, storage class — is one JSON record, escaped to ASCII, under the user
 * metadata name `celld-r2`:
 *
 *   {"custom":{…},"http":{"contentType":…,"cacheExpiry":…},"checksums":{"md5":"…"},"storageClass":…}
 *
 * An object without the record (written by another tool) still reads: its user metadata is its
 * customMetadata and its headers its httpMetadata. etag and upload time are the store's own.
 * Multipart parts wait under `r2-uploads/<bucket_name>/<uploadId>/` until completion.
 */
const ENVELOPE = "celld-r2";
type HttpField =
  | "contentType"
  | "contentLanguage"
  | "contentDisposition"
  | "contentEncoding"
  | "cacheControl";
const HTTP: HttpField[] = [
  "contentType",
  "contentLanguage",
  "contentDisposition",
  "contentEncoding",
  "cacheControl",
];

/** serde_json escaped to ASCII: every non-ASCII UTF-16 unit as \uXXXX. */
const asciiJson = (v: unknown) =>
  JSON.stringify(v).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

interface Envelope {
  custom?: Record<string, string>;
  http?: R2HTTPMetadata & { cacheExpiry?: number };
  checksums?: Record<string, string>;
  storageClass?: string;
}

export function celldR2Backend(store: ObjectStore, bucketName: string): R2Backend {
  const prefix = `r2/${bucketName}/`;
  const uploads = `r2-uploads/${bucketName}/`;
  const metaOf = (
    key: string,
    o: { body: Uint8Array; etag: string; attrs?: ObjectAttributes; modifiedMs?: number },
  ): StoredMeta => {
    const raw = o.attrs?.metadata?.[ENVELOPE];
    let env: Envelope | undefined;
    try {
      env = raw ? (JSON.parse(raw) as Envelope) : undefined;
    } catch {
      env = undefined;
    }
    const http: Record<string, unknown> = {};
    for (const f of HTTP) if (o.attrs?.[f] !== undefined) http[f] = o.attrs[f];
    if (env?.http?.cacheExpiry !== undefined) http.cacheExpiry = new Date(env.http.cacheExpiry);
    const custom: Record<string, string> = env
      ? { ...env.custom }
      : Object.fromEntries(Object.entries(o.attrs?.metadata ?? {}).filter(([k]) => k !== ENVELOPE));
    const etag = o.etag.replace(/^"(.*)"$/, "$1");
    return {
      key,
      size: o.body.byteLength,
      etag,
      version: etag,
      uploaded: o.modifiedMs ?? Date.now(),
      httpMetadata: http as R2HTTPMetadata,
      customMetadata: custom,
      md5: env?.checksums?.md5,
    };
  };
  return {
    async meta(key) {
      const o = await store.get(prefix + key);
      return o ? metaOf(key, o) : undefined;
    },
    async body(key) {
      return (await store.get(prefix + key))?.body;
    },
    async write(key, bytes, m) {
      const attrs: ObjectAttributes = {};
      const httpRecord: Record<string, unknown> = {};
      for (const f of HTTP) {
        const v = (m.httpMetadata as Record<string, unknown>)[f];
        if (typeof v === "string") {
          attrs[f] = v;
          httpRecord[f] = v;
        }
      }
      const expiry = (m.httpMetadata as { cacheExpiry?: Date | number }).cacheExpiry;
      if (expiry !== undefined)
        httpRecord.cacheExpiry = expiry instanceof Date ? expiry.getTime() : Number(expiry);
      // Field order and omissions as celld's serde struct (empty maps skipped).
      const env: Envelope = {};
      if (Object.keys(m.customMetadata).length)
        env.custom = Object.fromEntries(Object.entries(m.customMetadata).sort());
      env.http = httpRecord as Envelope["http"];
      env.checksums = { md5: m.md5 };
      attrs.metadata = { [ENVELOPE]: asciiJson(env) };
      await store.put(prefix + key, bytes, undefined, attrs);
      const o = await store.get(prefix + key);
      if (!o) throw new Error(`R2 put: ${key} vanished after its write`);
      return metaOf(key, o);
    },
    async remove(key) {
      await store.delete(prefix + key);
    },
    async keys() {
      return (await store.list(prefix)).map((k) => k.slice(prefix.length));
    },
    scratch: {
      async write(path, bytes) {
        await store.put(uploads + path, bytes);
      },
      async read(path) {
        return (await store.get(uploads + path))?.body;
      },
      async removeDir(path) {
        for (const k of await store.list(`${uploads}${path}/`)) await store.delete(k);
      },
    },
  };
}
