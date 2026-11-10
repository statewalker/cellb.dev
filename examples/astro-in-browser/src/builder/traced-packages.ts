/** A PackageStore that records each package it hands out: name, importer, version, time. */
import type { PackageStore } from "@statewalker/webrun-bundler";
import type { Trace } from "./trace.js";

export function tracedPackages(store: PackageStore, trace: Trace): PackageStore {
  const seen = new Set<string>();
  return {
    async get(name, importer) {
      const t = performance.now();
      const m = await store.get(name, importer);
      const key = `${name} <- ${importer.mount.prefix}`;
      if (!seen.has(key)) {
        seen.add(key);
        trace.add(
          "packages",
          m ? `${name} -> ${m.prefix}` : `${name}: not found`,
          {
            importer: importer.mount.prefix,
            version: m?.prefix.slice(m.prefix.lastIndexOf("@") + 1),
          },
          performance.now() - t,
        );
      }
      return m;
    },
  };
}
