// The tab side and the ServiceWorker side of a project shared by the tabs of an origin, without
// the runtime the shards run: a page that joins a project (`joinProjectShards`) and the
// ServiceWorker that routes to it (`installProjectRouter`) import this entry, the shard worker
// imports `@statewalker/cellb/browser` (`serveProjectShard`). The same names are also exported
// by `@statewalker/cellb/browser`, but a bundle that imports them from there carries the shard
// runtime it never runs.
export {
  installProjectRouter,
  joinProjectShards,
  type ProjectTabs,
  type ProjectTabsOptions,
  type ServiceWorkerScope,
  shardOwner,
} from "./project/browser-tabs.js";
