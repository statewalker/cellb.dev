import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { filesApiLtxLog } from "../src/index.js";
import { loadNodeProject } from "../src/project/node-project.js";

// A facet whose class comes from a Worker Loader runs inside the isolate (note 21) — and its
// database is now logged through the host like any facet: one LTX stream under the root,
// celld's key, so a fresh node restores it.
const project = join(__dirname, "../conformance/projects/isolation-api");
const run = async (files: MemFilesApi) => {
  const log = filesApiLtxLog(files, { epoch: 1 });
  return (
    await loadNodeProject(project, {
      openSql: nodeSqliteOpener(mkdtempSync(join(tmpdir(), "iso-facet-"))),
      files: new MemFilesApi(),
      durability: log,
      backup: log,
    })
  ).runtime;
};

describe("P11e facets of isolated loaded code are logged by the host", () => {
  it("LTX stream under <root>/facets/<sha256(name)>; a fresh node continues the facet's state", async () => {
    const files = new MemFilesApi();
    const a = await run(files);
    const first = await (await a.fetch(new Request("http://x/facet"))).json();
    expect([first.a.n, first.b.n]).toEqual([1, 2]);
    await a.close();
    const keys: string[] = [];
    for await (const f of files.list("/cells", { recursive: true }))
      if (f.kind === "file") keys.push(f.path);
    const segment = createHash("sha256").update("box").digest("hex").slice(0, 32);
    expect(
      keys.some((k) => /\/cells\/Holder:[0-9a-f]{64}\/facets\//.test(k) && k.includes(segment)),
    ).toBe(true);
    const b = await run(files);
    const again = await (await b.fetch(new Request("http://x/facet"))).json();
    expect([again.a.n, again.b.n]).toEqual([3, 4]);
    await b.close();
  }, 60_000);
});
