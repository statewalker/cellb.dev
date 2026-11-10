/**
 * Fetch functions that send npm registry requests to the package store (`PackageRegistry`):
 * from inside the platform (a Durable Object stub) or from outside it (HTTP, the Node runner).
 * No `cloudflare:*` import, so Node code can use it too.
 */
export interface RegistryEnv {
  REGISTRY: DurableObjectNamespace;
  REGISTRY_URL?: string;
  PACKUMENT_TTL_S?: string;
}

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** The package name a registry path names: `/@scope/name`, `/@scope%2fname`, `/name/-/name-1.0.0.tgz`. */
export function packageNameOf(path: string): string {
  return parseRegistryPath(path)?.name ?? "";
}

/** An npm package name: `name` or `@scope/name`, URL-safe characters only. */
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i; // legacy names have capitals (JSONStream)

/**
 * The two registry documents the package store serves, or `undefined` for anything else:
 * `/<name>` (`/@scope%2fname` or `/@scope/name`) is the packument, `/<name>/-/<file>.tgz` a
 * tarball. Other paths (`/react/latest`, `/react/18.2.0`) are refused: they are other documents,
 * which must not be cached as the packument.
 */
export function parseRegistryPath(
  path: string,
):
  | { name: string; kind: "packument" }
  | { name: string; kind: "tarball"; file: string }
  | undefined {
  let p: string;
  try {
    p = decodeURIComponent(path.replace(/^\/+/, ""));
  } catch {
    return undefined;
  }
  const parts = p.split("/");
  const scoped = parts[0]?.startsWith("@");
  const name = scoped ? `${parts[0]}/${parts[1] ?? ""}` : (parts[0] ?? "");
  const rest = parts.slice(scoped ? 2 : 1);
  if (!NAME.test(name)) return undefined;
  if (rest.length === 0) return { name, kind: "packument" };
  if (rest.length === 2 && rest[0] === "-" && /^[a-z0-9][a-z0-9._~-]*\.tgz$/i.test(rest[1]))
    return { name, kind: "tarball", file: rest[1] };
  return undefined;
}

export function stub(ns: DurableObjectNamespace, name: string): DurableObjectStub {
  return ns.getByName ? ns.getByName(name) : ns.get(ns.idFromName(name));
}

/**
 * A `fetch` for `npmRegistrySource({ fetch })`: registry URLs go to the package store's object
 * for that package; any other URL is fetched as is.
 */
export function registryFetch(env: RegistryEnv): typeof fetch {
  const registry = (env.REGISTRY_URL ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${registry}/`)) return fetch(input, init);
    const path = url.slice(registry.length);
    return stub(env.REGISTRY, packageNameOf(path)).fetch(`http://registry${"/registry"}${path}`);
  }) as typeof fetch;
}

/**
 * A `fetch` for code outside the platform (the Node build runner): registry URLs go to a
 * platform's `/registry/` endpoint over HTTP.
 */
export function remoteRegistryFetch(
  platformOrigin: string,
  registry = DEFAULT_REGISTRY,
): typeof fetch {
  const base = platformOrigin.replace(/\/+$/, "");
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${registry}/`)) return fetch(input, init);
    return fetch(`${base}/registry${url.slice(registry.length)}`, init);
  }) as typeof fetch;
}
