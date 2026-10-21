import type { DurableObjectNamespace } from "../core/namespace.js";

/**
 * The `KVNamespace` binding API (env.MY_KV.get/put/…) for Miniflare's KV simulator.
 * In workerd this client is native C++ that speaks HTTP to the simulator; here it is
 * TypeScript speaking the same protocol (Miniflare src/workers/kv/namespace.worker.ts):
 *   GET    /<key>?urlencoded=true[&cache_ttl]      → value, CF-Expiration, CF-KV-Metadata
 *   PUT    /<key>?urlencoded=true[&expiration|expiration_ttl] + CF-KV-Metadata
 *   DELETE /<key>?urlencoded=true
 *   GET    /?prefix&key_count_limit&cursor         → { keys, list_complete, cursor? }
 * One simulator object per namespace id; `cf.miniflare.name` carries the namespace name.
 */
export type KVGetType = "text" | "json" | "arrayBuffer" | "stream";

export interface KVPutOptions {
  expiration?: number;
  expirationTtl?: number;
  metadata?: unknown;
}

export function kvNamespaceBinding(objects: DurableObjectNamespace, namespaceId: string) {
  const stub = objects.getByName(namespaceId);
  const call = (
    path: string,
    params: Record<string, string | number | undefined>,
    init: RequestInit = {},
  ) => {
    const url = new URL(`http://kv.local${path}`);
    for (const [k, v] of Object.entries(params))
      if (v !== undefined) url.searchParams.set(k, String(v));
    return stub.fetch(url, { ...init, cf: { miniflare: { name: namespaceId } } } as RequestInit);
  };
  const keyPath = (key: string) => `/${encodeURIComponent(key)}`;
  const decode = async (res: Response, type: KVGetType) => {
    if (type === "json") return res.json();
    if (type === "arrayBuffer") return res.arrayBuffer();
    if (type === "stream") return res.body;
    return res.text();
  };
  const fail = async (res: Response) => {
    throw new Error(`KV ${res.status}: ${(await res.text()) || res.statusText}`);
  };
  const typeOf = (opt?: KVGetType | { type?: KVGetType }) =>
    (typeof opt === "string" ? opt : opt?.type) ?? "text";

  return {
    async get(key: string, opt?: KVGetType | { type?: KVGetType; cacheTtl?: number }) {
      const res = await call(keyPath(key), {
        urlencoded: "true",
        cache_ttl: typeof opt === "object" ? opt.cacheTtl : undefined,
      });
      if (res.status === 404) return null;
      if (!res.ok) return fail(res);
      return decode(res, typeOf(opt));
    },
    async getWithMetadata(key: string, opt?: KVGetType | { type?: KVGetType }) {
      const res = await call(keyPath(key), { urlencoded: "true" });
      if (res.status === 404) return { value: null, metadata: null };
      if (!res.ok) return fail(res);
      const meta = res.headers.get("CF-KV-Metadata");
      return {
        value: await decode(res, typeOf(opt)),
        metadata: meta === null ? null : JSON.parse(meta),
      };
    },
    async put(
      key: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
      options: KVPutOptions = {},
    ) {
      const body = ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : value;
      const headers: Record<string, string> = {};
      if (options.metadata !== undefined)
        headers["CF-KV-Metadata"] = JSON.stringify(options.metadata);
      if (typeof value === "string")
        headers["Content-Length"] = String(new TextEncoder().encode(value).byteLength);
      const res = await call(
        keyPath(key),
        {
          urlencoded: "true",
          expiration: options.expiration,
          expiration_ttl: options.expirationTtl,
        },
        { method: "PUT", headers, body: body as BodyInit, duplex: "half" } as RequestInit,
      );
      if (!res.ok) await fail(res);
    },
    async delete(key: string) {
      const res = await call(keyPath(key), { urlencoded: "true" }, { method: "DELETE" });
      if (!res.ok) await fail(res);
    },
    async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const res = await call("/", {
        prefix: options.prefix,
        key_count_limit: options.limit,
        cursor: options.cursor,
      });
      if (!res.ok) return fail(res);
      const out = (await res.json()) as {
        keys: { name: string; expiration?: number; metadata?: unknown }[];
        list_complete: boolean;
        cursor?: string;
      };
      // The simulator returns metadata as stored (JSON text); workerd's binding parses it.
      for (const k of out.keys)
        if (typeof k.metadata === "string") k.metadata = JSON.parse(k.metadata);
      return out;
    },
  };
}
