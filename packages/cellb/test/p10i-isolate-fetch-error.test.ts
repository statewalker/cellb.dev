import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { loadNodeProject, nodeSqliteOpener } from "../src/node.js";

// An error a loaded Worker's fetch handler throws in its own isolate reaches the caller with its
// own properties: message, name, code, and the stack where it was thrown in the isolate
// (src/isolate/protocol.ts serves the fetch with webrun-http-streams, whose error header leaves
// the stack out unless asked since 0.6).
describe("P10i an isolate's fetch error crosses to the caller", () => {
  it("keeps the message, name, code and the isolate's stack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iso-fetch-error-"));
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
      fetch() { return throwInIsolate(); },
    };
    function throwInIsolate() {
      const err = new TypeError("thrown in the isolate");
      err.code = "E_ISOLATE";
      throw err;
    }`;
    writeFileSync(
      join(dir, "index.js"),
      `export default { async fetch(req, env) {
        const w = env.LOADER.get("e1", () => ({ compatibilityDate: "2026-01-01", mainModule: "c.js", modules: { "c.js": ${JSON.stringify(child)} } }));
        try {
          await w.getEntrypoint().fetch(new Request("http://child/"));
          return new Response("no error");
        } catch (err) {
          return Response.json({ message: err.message, name: err.name, code: err.code, stack: String(err.stack) });
        }
      } };`,
    );
    const { runtime } = await loadNodeProject(dir, {
      openSql: nodeSqliteOpener(),
      files: new MemFilesApi(),
    });
    try {
      const res = await runtime.fetch(new Request("http://s/"));
      const err = (await res.json()) as Record<string, string>;
      expect(err.message).toBe("thrown in the isolate");
      expect(err.name).toBe("TypeError");
      expect(err.code).toBe("E_ISOLATE");
      expect(err.stack).toContain("throwInIsolate");
    } finally {
      await runtime.close();
    }
  }, 30_000);
});
