/// <reference lib="webworker" />
// The router of every project under /tabs/app/<name>/, fed by the shard workers of the open tabs.
// Its own URL's query sets router options (each test context registers its own):
//   ?strip=1                      stripBase
//   ?root=<name>&host=<page>&wait=<ms>
//                                 a root project, with a host page for navigations no tab serves
import { installProjectRouter } from "../../../src/browser.js";

declare const self: ServiceWorkerGlobalScope;
self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
const q = new URL(self.location.href).searchParams;
const root = q.get("root");
installProjectRouter(self, {
  basePath: "/tabs/app/",
  stripBase: q.has("strip"),
  root: root
    ? {
        name: root,
        // The fixture's own files stay the page's, and so do Vite's: a controlled client (the
        // shard workers) sends every request to this worker, whatever its path, its module
        // imports included. These are Vite's own paths: a Vite that adds another would send it
        // to the root project, and only the root-mode tests would fail (hanging on that import).
        passthrough: [
          "/@fs/",
          "/@vite/",
          "/@id/",
          "/node_modules/",
          "/src/",
          "/tabs/index.html",
          "/tabs/main.ts",
          "/tabs/sw.ts",
          "/tabs/shard-worker.ts",
          "/tabs/host.html",
        ],
        hostPage: q.get("host") ?? undefined,
        hostWaitMs: Number(q.get("wait") ?? 2_000),
      }
    : undefined,
});
