// The route table as a fragment host is given it (statewalker-root ADR
// 2026-11-21-route-table-and-discovery), and the HTTP link a service binding takes to a fragment
// placed on another host (#192). Shared by the Node host and the browser's shard workers.
import type { Send } from "../transport/cells-link.js";

/**
 * Where a fragment is served: here, on a peer (`/peers/{peerId}/fragments/{id}/…` through the
 * HTTPeers gateway), or at a host's URL (`<url>/fragments/{id}/…`).
 */
export interface FragmentRoute {
  readonly host: "local" | `peer:${string}` | `url:${string}`;
}

/** The route table: unlisted fragments are local. A function is asked at each call. */
export type FragmentRoutes =
  | Readonly<Record<string, FragmentRoute>>
  | ((id: string) => FragmentRoute | undefined);

/** Where `id` is served, by `routes`: "local" when unlisted. */
export function hostOf(routes: FragmentRoutes | undefined, id: string): FragmentRoute["host"] {
  const route = typeof routes === "function" ? routes(id) : routes?.[id];
  return route?.host ?? "local";
}

/**
 * The base URL of fragment `id` served at `host` (not "local"); undefined for a peer when there
 * is no gateway (`peers`, its origin).
 */
export function remoteBase(host: string, id: string, peers?: string): string | undefined {
  const at = `fragments/${encodeURIComponent(id)}/`;
  if (host.startsWith("url:")) {
    const base = host.slice(4);
    return new URL(at, base.endsWith("/") ? base : `${base}/`).href;
  }
  if (host.startsWith("peer:") && peers)
    return new URL(`/peers/${encodeURIComponent(host.slice(5))}/${at}`, peers).href;
  return undefined;
}

/** A link to `base`: each request of a service call is sent there, its headers and body as they are. */
export function linkTo(base: string, send: (req: Request) => Promise<Response>): Send {
  return (req) =>
    send(
      new Request(base, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: null,
        ...(req.body ? { duplex: "half" } : {}),
      } as RequestInit),
    );
}
