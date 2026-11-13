/// <reference lib="webworker" />
// The origin's ServiceWorker. It does two things:
// - it gives the host page and its workers cross-origin isolation, by adding COOP/COEP to the
//   responses of /__cellb/ (Astro's compiler needs SharedArrayBuffer), as coi-serviceworker does;
// - it routes every other path of the origin to the project the host page built ("app"); a
//   navigation that finds no tab running it goes to the chooser, /__cellb/start.html.
import { installProjectRouter } from "@statewalker/cellb/tabs";

declare const self: ServiceWorkerGlobalScope;
self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

const HOST = "/__cellb/";
const isolated = (res: Response): Response => {
  if (res.status === 0 || res.type === "opaque") return res;
  const headers = new Headers(res.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(HOST)) return;
  if (url.pathname.startsWith("/__cellb/projects/")) return; // the router's
  e.respondWith(fetch(e.request).then(isolated));
});

installProjectRouter(self, {
  basePath: "/__cellb/projects/",
  // The chooser (browser/start.html): where a navigation lands when no tab runs the site, so
  // that either app can be picked (it was the small app's host page, which rebuilt that one).
  root: { name: "app", passthrough: [HOST], hostPage: `${HOST}start.html` },
});
