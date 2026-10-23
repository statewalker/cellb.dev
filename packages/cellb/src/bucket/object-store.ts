/**
 * The bucket celld needs (docs/guarantees.md): conditional create, conditional overwrite,
 * read-after-write, ranged reads, listing. One interface, several stores: memory, a webrun
 * FilesApi (OPFS in browsers), celld dev's local `objects.sqlite3` (Node), and S3-compatible
 * HTTP (SigV4 over fetch — works from a browser when the bucket allows CORS).
 */
export interface StoredObject {
  body: Uint8Array;
  etag: string;
  /** Content headers and user metadata, as the bucket keeps them beside the bytes. */
  attrs?: ObjectAttributes;
  /** Last modification, ms since the epoch (R2's `uploaded`). */
  modifiedMs?: number;
}

/**
 * What a bucket stores beside an object's bytes (celld's BlobAttributes): the five content
 * headers, and flat user metadata (S3 `x-amz-meta-*`). celld's R2 record lives in the
 * user-metadata entry `celld-r2`.
 */
export interface ObjectAttributes {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface PutConditions {
  /** "*": create only (fail if the key exists). */
  ifNoneMatch?: "*";
  /** Overwrite only if the current object has this etag. */
  ifMatch?: string;
}

export interface ObjectStore {
  get(key: string): Promise<StoredObject | undefined>;
  /** Returns the new etag; throws PreconditionFailedError when a condition fails. */
  put(
    key: string,
    body: Uint8Array,
    cond?: PutConditions,
    attrs?: ObjectAttributes,
  ): Promise<string>;
  /** Keys under a prefix, ascending. */
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export class PreconditionFailedError extends Error {
  constructor(key: string) {
    super(`precondition failed for ${key}`);
    this.name = "PreconditionFailedError";
  }
}

const checkConditions = (key: string, cur: StoredObject | undefined, cond?: PutConditions) => {
  if (cond?.ifNoneMatch === "*" && cur) throw new PreconditionFailedError(key);
  if (cond?.ifMatch !== undefined && cur?.etag !== cond.ifMatch)
    throw new PreconditionFailedError(key);
};

export function memoryObjectStore(): ObjectStore {
  const objects = new Map<string, StoredObject>();
  let n = 0;
  return {
    async get(key) {
      return objects.get(key);
    },
    async put(key, body, cond, attrs) {
      checkConditions(key, objects.get(key), cond);
      const etag = String(++n);
      objects.set(key, {
        body: body.slice(),
        etag,
        attrs: attrs ? structuredClone(attrs) : undefined,
        modifiedMs: Date.now(),
      });
      return etag;
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

/**
 * A FilesApi as a bucket (OPFS, node fs, …). Conditions are checked then written — atomic
 * only within one writer (a browser tab, or one process): for several writers use a store
 * with real conditional writes (S3, celld dev's SQLite store).
 */
export function filesApiObjectStore(
  files: import("@statewalker/webrun-files").FilesApi,
  root = "/bucket",
): ObjectStore {
  const path = (key: string) => `${root}/${key}`;
  const etagPath = (key: string) => `${root}/.etags/${key}`;
  const attrsPath = (key: string) => `${root}/.attrs/${key}.json`;
  const read = async (p: string) => {
    if (!(await files.exists(p))) return undefined;
    const chunks: Uint8Array[] = [];
    for await (const c of files.read(p)) chunks.push(c);
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  };
  let lock: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = lock.then(fn, fn);
    lock = r.catch(() => {});
    return r;
  };
  return {
    async get(key) {
      const body = await read(path(key));
      if (!body) return undefined;
      const side = await read(attrsPath(key));
      const extra = side
        ? (JSON.parse(new TextDecoder().decode(side)) as {
            attrs?: ObjectAttributes;
            modifiedMs?: number;
          })
        : {};
      return {
        body,
        etag: new TextDecoder().decode((await read(etagPath(key))) ?? new Uint8Array()),
        ...extra,
      };
    },
    put(key, body, cond, attrs) {
      return serial(async () => {
        checkConditions(key, await this.get(key), cond);
        const etag = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
        await files.write(path(key), [body]);
        await files.write(etagPath(key), [new TextEncoder().encode(etag)]);
        await files.write(attrsPath(key), [
          new TextEncoder().encode(JSON.stringify({ attrs, modifiedMs: Date.now() })),
        ]);
        return etag;
      });
    },
    async list(prefix) {
      const out: string[] = [];
      if (!(await files.exists(root))) return out;
      for await (const f of files.list(root, { recursive: true }))
        if (f.kind === "file") {
          const key = f.path.slice(root.length + 1);
          if (!key.startsWith(".etags/") && !key.startsWith(".attrs/") && key.startsWith(prefix))
            out.push(key);
        }
      return out.sort();
    },
    async delete(key) {
      await files.remove(path(key));
      await files.remove(etagPath(key));
      await files.remove(attrsPath(key));
    },
  };
}
