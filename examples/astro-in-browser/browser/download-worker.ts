/// <reference lib="webworker" />
// A download worker: fetches a package from the npm registry (packument and tarball, gunzip and
// untar in this worker), packs it (one file, see package-cache.ts), and PUTs the pack to the
// package store. Several run at once; none of them keeps a package once it is stored.
import { npmRegistrySource } from "@statewalker/webrun-modules";
import { packOf } from "../src/builder/package-cache.ts";

const registry = npmRegistrySource();
self.onmessage = async (
  e: MessageEvent<{ id: number; pkg: string; version?: string; store: string }>,
) => {
  const { id, pkg, version, store } = e.data;
  try {
    const p = await registry.load({ pkg, version });
    const { chunks, files, bytes } = await packOf(p.files as never);
    const url = `${store}/files/pkgs/${encodeURIComponent(`${p.name}@${p.version}.pack`).replaceAll("%2F", "/").replaceAll("%40", "@")}`;
    const r = await fetch(url, { method: "PUT", body: new Blob(chunks as BlobPart[]) });
    if (!r.ok) throw new Error(`PUT ${url} → ${r.status}: ${(await r.text()).slice(0, 400)}`);
    postMessage({ id, name: p.name, version: p.version, files, bytes });
  } catch (err) {
    postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
