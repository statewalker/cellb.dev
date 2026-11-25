/**
 * What a tab and a shard worker it starts agree on (`joinProjectShards` → `serveProjectShard`).
 * Its own module, with type-only imports, so that the tab side and the ServiceWorker do not
 * import the shard's runtime (browser-shards.ts → browser-host.ts and every binding) for two
 * constants.
 */
import type { BrowserBucket, BrowserProjectOptions } from "./browser-host.js";
import type { FragmentRoute } from "./fragment-routes.js";

/**
 * A shard of a project shared by the tabs of an origin (`joinProjectShards`): it serves through
 * the ServiceWorker's router (webrun-http-browser's `serveHttpInWorker`), which the tab attaches
 * it to, and reaches the other shards through it.
 */
export const TAB_INIT = "cellb:tab-shard";
/** The host calls between shards go to through the router: `http://cellb.internal/<project>/`. */
export const INTERNAL_ORIGIN = "http://cellb.internal";

/** What a shard worker shared by tabs is told: no peers, it reaches them through the router. */
export interface TabShardInit {
  type: typeof TAB_INIT;
  name: string;
  shard: number;
  shards: number;
  config: BrowserProjectOptions["config"];
  code: BrowserProjectOptions["code"];
  assetFiles?: BrowserProjectOptions["assetFiles"];
  /** The OpenAI-compatible endpoint behind the project's `ai` binding. */
  ai?: BrowserProjectOptions["ai"];
  bucket?: BrowserBucket;
  pool: string;
  filesDir: string;
}

/** The router's key of the fragment host's shard pool: `<basePath>fragments/<id>/…`. */
export const FRAGMENTS_KEY = "fragments";
/** A shard worker of the fragment host is started (`joinFragmentShards` → `serveFragmentShard`). */
export const FRAGMENT_SHARD_INIT = "cellb:fragment-shard";
/** A fragment is loaded into a shard worker of the fragment host. */
export const FRAGMENT_ADD = "cellb:fragment-add";
/** A fragment leaves a shard worker of the fragment host (its data is kept). */
export const FRAGMENT_REMOVE = "cellb:fragment-remove";

/** What a shard worker of the fragment host is told when it starts. */
export interface FragmentShardInit {
  type: typeof FRAGMENT_SHARD_INIT;
  shard: number;
  shards: number;
  /**
   * The path page requests for fragments start with (`<basePath>fragments/`): `<prefix><id>/<path>`
   * reaches fragment `id`'s fragment DO at `/<path>`.
   */
  prefix: string;
  /**
   * The route table (#192): where fragments this host does not serve are; a service binding to one
   * goes there over HTTP. Unlisted fragments are local.
   */
  routes?: Record<string, FragmentRoute>;
  /** The origin of the HTTPeers gateway serving `/peers/{peerId}/…`, for `peer:` routes. */
  peers?: string;
}

/** A fragment, as a shard worker of the fragment host loads it. */
export interface FragmentShardAdd {
  type: typeof FRAGMENT_ADD;
  id: string;
  config: BrowserProjectOptions["config"];
  code: BrowserProjectOptions["code"];
  assetFiles?: BrowserProjectOptions["assetFiles"];
  ai?: BrowserProjectOptions["ai"];
  /** The Durable Object binding of its fragment DO (default: FRAGMENT, or the only one). */
  entry?: string;
}
