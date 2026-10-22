import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { loadNodeProject } from "../src/project/node-project.js";

// celld's own KV (vendor/celld/kv.js) on webrun-cells: the large-value path (> 1 MiB)
// goes to the host's FilesApi through celld's prepare/put/get protocol.
describe("P08f celld's KV service on webrun-cells", () => {
  it("values above 1 MiB live in the FilesApi; streams and metadata round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "celldkv-"));
    writeFileSync(
      join(dir, "wrangler.jsonc"),
      JSON.stringify({ name: "k", main: "index.js", kv_namespaces: [{ binding: "KV", id: "ns" }] }),
    );
    writeFileSync(join(dir, "index.js"), "export default { fetch() { return new Response('') } }");
    const files = new MemFilesApi();
    const { runtime } = await loadNodeProject(dir, { openSql: nodeSqliteOpener(), files });
    const KV = runtime.env.KV as any;
    const big = new Uint8Array(2 * 1024 * 1024).map((_, i) => i % 251);
    await KV.put("big", big, { metadata: { size: big.length } });
    await KV.put("streamed", new Response("from a stream").body);
    const blobs: string[] = [];
    for await (const f of files.list("/kv-blobs", { recursive: true }))
      if (f.kind === "file") blobs.push(f.path);
    expect(blobs).toHaveLength(1);
    const got = await KV.getWithMetadata("big", "arrayBuffer");
    expect(new Uint8Array(got.value)).toEqual(big);
    expect(got.metadata).toEqual({ size: big.length });
    expect(await KV.get("streamed")).toBe("from a stream");
    expect((await KV.list()).keys.map((k: any) => k.name)).toEqual(["big", "streamed"]);
  }, 30_000); // the first project load bundles the Worker and the isolate entry
});
