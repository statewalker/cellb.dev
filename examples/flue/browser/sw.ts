/// <reference lib="webworker" />
// The router of the Flue app shared by the tabs: requests to /app/<name>/… reach it.
import { installProjectRouter } from "@statewalker/cellb/browser";

declare const self: ServiceWorkerGlobalScope;
self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
installProjectRouter(self, { basePath: "/app/" });
