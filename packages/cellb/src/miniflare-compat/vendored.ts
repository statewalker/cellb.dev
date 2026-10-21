// Typed entry points to the generated bundles in vendor/miniflare (scripts/vendor-miniflare.mjs).
import type { DurableObjectClass } from "../core/object-host.js";
// @ts-expect-error — generated JS, no declarations
import makeD1BindingJs from "../../vendor/miniflare/d1-api.js";
// @ts-expect-error — generated JS, no declarations
import { D1DatabaseObject as D1Js } from "../../vendor/miniflare/d1-database.js";
// @ts-expect-error — generated JS, no declarations
import { KVNamespaceObject as KVJs } from "../../vendor/miniflare/kv-namespace.js";

/** Miniflare's KV simulator object (workers-sdk, unchanged). */
export const KVNamespaceObject = KVJs as DurableObjectClass;
/** Miniflare's D1 simulator object (workers-sdk, unchanged). */
export const D1DatabaseObject = D1Js as DurableObjectClass;
/** workerd's D1 binding client (src/cloudflare/internal/d1-api.ts, unchanged). */
export const makeD1Binding = makeD1BindingJs as (env: { fetcher: { fetch: typeof fetch } }) => unknown;
