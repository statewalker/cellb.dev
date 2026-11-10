/**
 * What a tab and a shard worker it starts agree on (`joinProjectShards` → `serveProjectShard`).
 * Its own module, with type-only imports, so that the tab side and the ServiceWorker do not
 * import the shard's runtime (browser-shards.ts → browser-host.ts and every binding) for two
 * constants.
 */
import type { BrowserBucket, BrowserProjectOptions } from "./browser-host.js";

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
