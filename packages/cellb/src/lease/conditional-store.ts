/**
 * The one primitive a cross-host lease needs: compare-and-swap on a key.
 * S3 / R2 / MinIO: GET returns an ETag; PUT with `If-None-Match: *` (create
 * only) or `If-Match: <etag>` (replace only if unchanged) → 412 on conflict
 * (S3 may also answer 409 for concurrent conditional writes → retry).
 */
export interface Versioned {
  body: string;
  etag: string;
}

export class PreconditionFailedError extends Error {
  constructor(key: string) {
    super(`Precondition failed for "${key}"`);
    this.name = "PreconditionFailedError";
  }
}

export interface ConditionalStore {
  get(key: string): Promise<Versioned | undefined>;
  /** Throws PreconditionFailedError when the condition does not hold. */
  put(
    key: string,
    body: string,
    cond: { ifMatch: string } | { ifNoneMatch: "*" },
  ): Promise<{ etag: string }>;
}

/** In-memory store (tests; single process). */
export class MemoryConditionalStore implements ConditionalStore {
  #data = new Map<string, Versioned>();
  #n = 0;
  async get(key: string): Promise<Versioned | undefined> {
    return this.#data.get(key);
  }
  async put(
    key: string,
    body: string,
    cond: { ifMatch: string } | { ifNoneMatch: "*" },
  ): Promise<{ etag: string }> {
    const cur = this.#data.get(key);
    if ("ifNoneMatch" in cond ? cur !== undefined : cur?.etag !== cond.ifMatch)
      throw new PreconditionFailedError(key);
    const etag = `"${++this.#n}"`;
    this.#data.set(key, { body, etag });
    return { etag };
  }
}
