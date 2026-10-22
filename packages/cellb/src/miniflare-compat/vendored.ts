// Typed entry points to the generated bundles in vendor/miniflare (scripts/vendor-miniflare.mjs).

// @ts-expect-error — generated JS, no declarations
import makeD1BindingJs from "../../vendor/miniflare/d1-api.js";
// @ts-expect-error — generated JS, no declarations
import { D1DatabaseObject as D1Js } from "../../vendor/miniflare/d1-database.js";
// @ts-expect-error — generated JS, no declarations
import { KVNamespaceObject as KVJs } from "../../vendor/miniflare/kv-namespace.js";
import type { DurableObjectClass } from "../core/object-host.js";

/** Miniflare's KV simulator object (workers-sdk, unchanged). */
export const KVNamespaceObject = KVJs as DurableObjectClass;
/**
 * Miniflare's D1 simulator object (workers-sdk, unchanged). It asks its storage for
 * bookmarks (commit tokens of D1 sessions); celld's Durable Object storage has no bookmark
 * API (calling it is a TypeError), so only the simulator's instances get these methods.
 */
export const D1DatabaseObject = class CellsD1Database extends (D1Js as new (
  ctx: any,
  env: any,
) => object) {
  constructor(ctx: any, env: any) {
    let n = 0;
    Object.assign(ctx.storage, {
      getCurrentBookmark: async () =>
        `${Date.now().toString(16).padStart(12, "0")}-${(++n).toString(16).padStart(8, "0")}`,
      getBookmarkForTime: async (time: number | Date) =>
        `${new Date(time).getTime().toString(16).padStart(12, "0")}-00000000`,
    });
    super(ctx, env);
  }
} as unknown as DurableObjectClass;
/** workerd's D1 binding client (src/cloudflare/internal/d1-api.ts, unchanged). */
export const makeD1Binding = makeD1BindingJs as (env: {
  fetcher: { fetch: typeof fetch };
}) => unknown;
