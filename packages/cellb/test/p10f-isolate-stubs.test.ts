import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { loadNodeProject, nodeSqliteOpener } from "../src/node.js";

// An RpcTarget passed into a loaded Worker (its own isolate) is a stub there: its calls come
// back to the host, and disposing the stub releases the host's reference, which runs the
// target's own Symbol.dispose (workerd's rule).
describe("P10f stubs into a loaded Worker's isolate", () => {
  it("calls an RpcTarget back, and disposing its stub disposes the target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iso-stubs-"));
    writeFileSync(
      join(dir, "wrangler.jsonc"),
      JSON.stringify({
        name: "s",
        main: "index.js",
        compatibility_date: "2026-01-01",
        worker_loaders: [{ binding: "LOADER" }],
      }),
    );
    const child = `export default {
      async use(target) {
        const greeting = await target.greet("isolate");
        target[Symbol.dispose]();
        return greeting;
      },
    };`;
    writeFileSync(
      join(dir, "index.js"),
      `import { RpcTarget } from "cloudflare:workers";
      class Greeter extends RpcTarget {
        constructor(disposed) { super(); this.disposed = disposed; }
        greet(name) { return "hello " + name; }
        [Symbol.dispose]() { this.disposed(); }
      }
      export default { async fetch(req, env) {
        const w = env.LOADER.get("s1", () => ({ compatibilityDate: "2026-01-01", mainModule: "c.js", modules: { "c.js": ${JSON.stringify(child)} } }));
        let disposed;
        const released = new Promise((r) => (disposed = r));
        const greeting = await w.getEntrypoint().use(new Greeter(disposed));
        await released;
        return new Response(greeting + ", disposed");
      } };`,
    );
    const { runtime } = await loadNodeProject(dir, {
      openSql: nodeSqliteOpener(),
      files: new MemFilesApi(),
    });
    try {
      const res = await runtime.fetch(new Request("http://s/"));
      expect(await res.text()).toBe("hello isolate, disposed");
    } finally {
      await runtime.close();
    }
  }, 30_000);
});
