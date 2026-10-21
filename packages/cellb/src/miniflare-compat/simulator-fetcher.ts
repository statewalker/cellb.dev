import type { DurableObjectNamespace } from "../core/namespace.js";

/**
 * A `Fetcher` (what workerd hands to binding clients such as d1-api.ts) that reaches
 * one Miniflare simulator object. Miniflare's objects read their persistent name from
 * `request.cf.miniflare.name`, so every call carries it.
 */
export function simulatorFetcher(objects: DurableObjectNamespace, name: string) {
  const stub = objects.getByName(name);
  return {
    fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
      return stub.fetch(input, { ...init, cf: { miniflare: { name } } } as RequestInit);
    },
  };
}
