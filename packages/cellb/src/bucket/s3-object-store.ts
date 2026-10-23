import type { ObjectStore } from "./object-store.js";
import { PreconditionFailedError } from "./object-store.js";

/**
 * An S3-compatible bucket over fetch with AWS Signature V4 (WebCrypto): Amazon S3, R2,
 * Tigris, MinIO… — the stores celld qualifies. Runs in browsers (the bucket needs a CORS
 * rule exposing ETag and allowing If-Match / If-None-Match) and on Node. Path-style URLs:
 * `${endpoint}/${bucket}/${key}`.
 */
export interface S3Options {
  endpoint: string;
  bucket: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Key prefix inside the bucket (celld's `CELLD_BUCKET` path part). */
  prefix?: string;
  fetch?: typeof fetch;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (data: Uint8Array | string) =>
  hex(
    await crypto.subtle.digest(
      "SHA-256",
      typeof data === "string" ? enc.encode(data) : (data as BufferSource),
    ),
  );
const hmac = async (key: Uint8Array | ArrayBuffer, data: string) => {
  const k = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
};
const uriEncode = (s: string, slash = true) =>
  encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(slash ? /%2F/g : /$^/, "/");

export async function signV4(
  method: string,
  url: URL,
  headers: Record<string, string>,
  body: Uint8Array | undefined,
  o: Pick<S3Options, "region" | "accessKeyId" | "secretAccessKey" | "sessionToken">,
  now = new Date(),
): Promise<Record<string, string>> {
  const region = o.region ?? "auto";
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = await sha256(body ?? new Uint8Array());
  const h: Record<string, string> = {
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    host: url.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };
  if (o.sessionToken) h["x-amz-security-token"] = o.sessionToken;
  const names = Object.keys(h).sort();
  const query = [...url.searchParams]
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)])
    .sort(([a, b], [c, d]) => (a === c ? (b < d ? -1 : 1) : a < c ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    method,
    uriEncode(decodeURIComponent(url.pathname)),
    query,
    ...names.map((n) => `${n}:${h[n].trim()}`),
    "",
    names.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
  let key: Uint8Array = await hmac(enc.encode(`AWS4${o.secretAccessKey}`), day);
  for (const part of [region, "s3", "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  h.authorization = `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  delete h.host; // set by fetch
  return h;
}

export function s3ObjectStore(o: S3Options): ObjectStore {
  const f = o.fetch ?? fetch;
  const base = `${o.endpoint.replace(/\/$/, "")}/${o.bucket}`;
  // celld's `s3://BUCKET/PREFIX` puts keys under "PREFIX/": a prefix is a directory.
  const root = o.prefix ? (o.prefix.endsWith("/") ? o.prefix : `${o.prefix}/`) : "";
  const full = (key: string) => `${root}${key}`;
  const call = async (
    method: string,
    url: URL,
    headers: Record<string, string> = {},
    body?: Uint8Array,
  ) =>
    f(url, {
      method,
      headers: await signV4(method, url, headers, body, o),
      body: body as BodyInit | undefined,
    });
  return {
    async get(key) {
      const r = await call("GET", new URL(`${base}/${uriEncode(full(key))}`));
      if (r.status === 404) return undefined;
      if (!r.ok) throw new Error(`S3 GET ${key}: ${r.status} ${await r.text()}`);
      return { body: new Uint8Array(await r.arrayBuffer()), etag: r.headers.get("etag") ?? "" };
    },
    async put(key, body, cond) {
      const headers: Record<string, string> = {};
      if (cond?.ifNoneMatch) headers["if-none-match"] = "*";
      if (cond?.ifMatch !== undefined) headers["if-match"] = cond.ifMatch;
      const r = await call("PUT", new URL(`${base}/${uriEncode(full(key))}`), headers, body);
      // 409: a concurrent conditional write on some stores (R2, S3) — also a lost race.
      if (r.status === 412 || r.status === 409) throw new PreconditionFailedError(key);
      if (!r.ok) throw new Error(`S3 PUT ${key}: ${r.status} ${await r.text()}`);
      return r.headers.get("etag") ?? "";
    },
    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const url = new URL(`${base}/`);
        url.searchParams.set("list-type", "2");
        url.searchParams.set("prefix", full(prefix));
        if (token) url.searchParams.set("continuation-token", token);
        const r = await call("GET", url);
        if (!r.ok) throw new Error(`S3 LIST ${prefix}: ${r.status} ${await r.text()}`);
        const xml = await r.text();
        for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g))
          keys.push(unxml(m[1]).slice(root.length));
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
          ? unxml(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "")
          : undefined;
      } while (token);
      return keys.sort();
    },
    async delete(key) {
      const r = await call("DELETE", new URL(`${base}/${uriEncode(full(key))}`));
      if (!r.ok && r.status !== 404) throw new Error(`S3 DELETE ${key}: ${r.status}`);
    },
  };
}

const unxml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
