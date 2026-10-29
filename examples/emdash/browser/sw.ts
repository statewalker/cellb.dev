/// <reference lib="webworker" />
// The origin's router: every request outside /__cellb/ (the host page's own files) goes to the
// EmDash project, navigations included, with its URL unchanged: EmDash builds absolute paths
// (`/_emdash/…`), so it is served at the root, as on its own Cloudflare route.
import { installProjectRouter } from "@statewalker/cellb/browser";

declare const self: ServiceWorkerGlobalScope;
self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
installProjectRouter(self, {
  basePath: "/__cellb/projects/",
  // The host page's files, and this script itself in the static build.
  // A page opened while no tab runs the site goes to the host page first (`?next=` keeps it).
  root: {
    name: "emdash",
    passthrough: ["/__cellb/", "/cellb-sw.js"],
    hostPage: "/__cellb/",
  },
});
