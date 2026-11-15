import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { loadNodeProject, nodeSqliteOpener } from "../src/node.js";

// An error a loaded Worker's fetch handler throws in its own isolate reaches the caller with its
// own properties: message, name, code, and the stack where it was thrown in the isolate
// (src/isolate/protocol.ts serves the fetch with webrun-http-streams, whose error header leaves
// the stack out unless asked since 0.6). The other way, an error of the host's globalOutbound
// Fetcher reaches the loaded code without the host's stack (its frames and file paths).
describe("P10i fetch errors across an isolate", () => {
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

  it("an outbound error reaches the isolate without the host's stack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iso-outbound-error-"));
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
      async fetch() {
        try {
          await fetch("http://outside/");
          return new Response("no error");
        } catch (err) {
          return Response.json({ message: err.message, name: err.name, code: err.code, stack: String(err.stack) });
        }
      },
    };`;
    writeFileSync(
      join(dir, "index.js"),
      `function throwOnHost() {
        const err = new TypeError("thrown on the host");
        err.code = "E_HOST";
        throw err;
      }
      export default { async fetch(req, env) {
        const w = env.LOADER.get("o1", () => ({
          compatibilityDate: "2026-01-01",
          mainModule: "c.js",
          modules: { "c.js": ${JSON.stringify(child)} },
          globalOutbound: { fetch: async () => throwOnHost() },
        }));
        return w.getEntrypoint().fetch(new Request("http://child/"));
      } };`,
    );
    const { runtime } = await loadNodeProject(dir, {
      openSql: nodeSqliteOpener(),
      files: new MemFilesApi(),
    });
    try {
      const res = await runtime.fetch(new Request("http://s/"));
      const err = (await res.json()) as Record<string, string>;
      expect(err.message).toBe("thrown on the host");
      expect(err.name).toBe("TypeError");
      expect(err.code).toBe("E_HOST");
      expect(err.stack).not.toContain("throwOnHost");
      expect(err.stack).not.toContain("worker-loader");
    } finally {
      await runtime.close();
    }
  }, 30_000);
});
