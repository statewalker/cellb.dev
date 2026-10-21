/**
 * The Workers Cache API as celld provides it (cloudflare-compat.md#cache): an always-miss
 * cache, because there is no shared edge cache. `put()` validates and consumes the response
 * but stores nothing, `match()` resolves to `undefined`, `delete()` to `false`.
 * Substituted for the `caches` global of user code (browsers have a real CacheStorage).
 */
export class CellsCache {
  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const req = request instanceof Request ? request : new Request(request);
    if (req.method !== "GET") throw new TypeError("Cache.put() only accepts GET requests");
    if (!(response instanceof Response)) throw new TypeError("Cache.put() requires a Response");
    if (response.status === 206) throw new TypeError("Cache.put() cannot store a partial response");
    if (response.headers.get("vary") === "*")
      throw new TypeError("Cache.put() cannot store Vary: *");
    await response.body?.cancel();
  }
  async match(_request: RequestInfo | URL, _options?: unknown): Promise<Response | undefined> {
    return undefined;
  }
  async delete(_request: RequestInfo | URL, _options?: unknown): Promise<boolean> {
    return false;
  }
}

export class CellsCacheStorage {
  readonly default = new CellsCache();
  async open(_name: string): Promise<CellsCache> {
    return new CellsCache();
  }
}

export const cellsCaches = new CellsCacheStorage();
