import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { loadNodeProject } from "../src/project/node-project.js";

// An exception no request awaits (a timer, ctx.abort() from one) is reported and the isolate
// lives on, as a browser Dedicated Worker and workerd do; a Node worker thread would die and
// raise an unhandled 'error' in the host. Found by worker-loader-test.js's self-destruct export.
describe("P10d an uncaught exception in a loaded Worker", () => {
  it("leaves the isolate running, with its module state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iso-uncaught-"));
    writeFileSync(
      join(dir, "wrangler.jsonc"),
      JSON.stringify({
        name: "u",
        main: "index.js",
        compatibility_date: "2026-01-01",
        worker_loaders: [{ binding: "LOADER" }],
      }),
    );
    const child = `let n = 0;
      export default { fetch() { n++; setTimeout(() => { throw new Error("boom"); }, 5); return new Response(String(n)); } };`;
    writeFileSync(
      join(dir, "index.js"),
      `export default { fetch(req, env) {
        const w = env.LOADER.get("u1", () => ({ compatibilityDate: "2026-01-01", mainModule: "c.js", modules: { "c.js": ${JSON.stringify(child)} } }));
        return w.getEntrypoint().fetch("http://c/");
      } };`,
    );
    const { runtime } = await loadNodeProject(dir, {
      openSql: nodeSqliteOpener(),
      files: new MemFilesApi(),
    });
    const first = await (await runtime.fetch(new Request("http://u/"))).text();
    await new Promise((r) => setTimeout(r, 50)); // the timer has thrown
    const second = await (await runtime.fetch(new Request("http://u/"))).text();
    await runtime.close();
    expect([first, second]).toEqual(["1", "2"]);
  }, 30_000);
});
