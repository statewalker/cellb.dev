/// <reference lib="webworker" />
// The router of every project under /tabs/app/<name>/, fed by the shard workers of the open tabs.
import { installProjectRouter } from "../../../src/browser.js";

declare const self: ServiceWorkerGlobalScope;
self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
installProjectRouter(self, { basePath: "/tabs/app/" });
