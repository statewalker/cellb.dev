/// <reference lib="webworker" />
// The demo's ServiceWorker, served at /cellb-demo-sw.js: requests to /demo/counter/… from any
// tab reach the project, in whichever tab runs the shard of the cell they address.
import { installProjectRouter } from "@statewalker/cellb/browser";

declare const self: ServiceWorkerGlobalScope;
self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
installProjectRouter(self, { basePath: "/demo/" });
