// The demos' ServiceWorker (<base>sw-worker.js, built by vite.config.ts): webrun-http-browser's
// runtime, which routes a page's prefix (<base><key>/…) to a handler on that page, inside a shim
// that gives every page of its scope cross-origin isolation (a static host sends no COOP/COEP
// headers, and containers need SharedArrayBuffer).
import { SwHttpAdapter } from "@statewalker/webrun-http-browser/sw";

/** The app's base path: "/" in dev, "/demos/containers/" on the site. */
export const BASE = import.meta.env.BASE_URL;

/**
 * Starts the ServiceWorker for this page (`key`: the first path segment it routes to it) and makes
 * sure the page is cross-origin isolated: the first visit (controlled by a claim, not by a load)
 * reloads once through the worker.
 */
export async function startServiceWorker(key: string): Promise<SwHttpAdapter> {
  const adapter = new SwHttpAdapter({
    key,
    serviceWorkerUrl: new URL(`${BASE}sw-worker.js`, location.href).toString(),
    reloadIfUncontrolled: true,
  });
  await adapter.start();
  const COI_RELOAD = "containers-demo-coi-reload";
  if (crossOriginIsolated) sessionStorage.removeItem(COI_RELOAD);
  else if (!sessionStorage.getItem(COI_RELOAD)) {
    sessionStorage.setItem(COI_RELOAD, "1");
    location.reload();
    await new Promise(() => {}); // the reload replaces this page
  } else
    throw new Error("this page is not cross-origin isolated (SharedArrayBuffer is unavailable)");
  return adapter;
}
