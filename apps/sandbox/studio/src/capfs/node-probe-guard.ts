// Vendored from statewalker-sandbox/apps/flue-capfs-do (2641939, 2026-11-11); changes marked "studio:".
// pi-ai probes node:fs, node:os and node:path with dynamic imports while it loads, whenever
// `process.versions.node` is set. cellb's browser host sets it (its `process` polyfill reports
// Node 22) but has no node: modules, so each probe becomes an unhandled "Failed to fetch
// dynamically imported module". The probes are only for reading credential files, which a
// browser has none of: this module hides `versions.node` while the modules load and
// `restoreNodeVersions()` (called from the entry's body, after every import has run) puts it
// back. Elsewhere (workerd, Node) it does nothing.
// It must be the entry's first import.

const hidden =
  typeof process !== "undefined" &&
  (process.platform as string) === "browser" &&
  process.versions?.node
    ? process.versions.node
    : undefined;
if (hidden !== undefined) delete (process.versions as { node?: string }).node;

export function restoreNodeVersions() {
  if (hidden !== undefined) (process.versions as { node?: string }).node = hidden;
}
