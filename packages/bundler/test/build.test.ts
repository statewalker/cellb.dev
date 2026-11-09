import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";
import { buildProject, loaderPayload } from "../src/build.js";

async function project(files: Record<string, string>) {
  const fs = new MemFilesApi();
  for (const [p, t] of Object.entries(files)) await writeText(fs, p, t);
  return fs;
}

describe("buildProject", () => {
  it("bundles a Worker into a no_bundle project, with assets, migrations and portable bindings", async () => {
    const files = await project({
      "/wrangler.jsonc": `{ "name": "w", "main": "src/index.ts", "compatibility_date": "2026-02-24",
        "compatibility_flags": ["nodejs_compat"], "assets": { "directory": "./public" },
        "kv_namespaces": [{ "binding": "SESSION" }], "d1_databases": [{ "binding": "DB", "database_name": "d" }] }`,
      "/src/index.ts": `import { DurableObject } from "cloudflare:workers";
        import { createHash } from "node:crypto";
        import { greet } from "./greet";
        export class C extends DurableObject {}
        export default { fetch: () => new Response(greet(createHash("sha1").update("x").digest("hex"))) };`,
      "/src/greet.ts": `export const greet = (s: string): string => "hi " + s;`,
      "/public/index.html": "<h1>hi</h1>",
      "/migrations/0001_init.sql": "CREATE TABLE t (x);",
    });
    const out = await buildProject({ files, esbuild, spec: { sourcemap: false } });
    const config = JSON.parse(new TextDecoder().decode(out.files.get("/wrangler.json")));
    expect(config).toMatchObject({
      main: "worker.js",
      no_bundle: true,
      assets: { directory: "assets" },
      kv_namespaces: [{ binding: "SESSION", id: "w-session" }],
    });
    expect([...out.files.keys()].sort()).toEqual([
      "/assets/index.html",
      "/migrations/0001_init.sql",
      "/worker.js",
      "/wrangler.json",
    ]);
    const code = new TextDecoder().decode(out.files.get("/worker.js"));
    expect(code).toContain('from "cloudflare:workers"');
    expect(code).toContain('from "node:crypto"');
    expect(code).toContain("hi ");
    expect(code).not.toContain(": string"); // TypeScript stripped
    expect(loaderPayload(out)).toMatchObject({
      mainModule: "worker.js",
      compatibilityFlags: ["nodejs_compat"],
    });
  });

  it("wraps the default handler for host compatibility, keeping named exports", async () => {
    const files = await project({
      "/wrangler.json": `{ "name": "w", "main": "index.js", "d1_databases": [{ "binding": "DB" }] }`,
      "/index.js": `export class K {} export default { fetch: () => new Response("ok") };`,
    });
    const out = await buildProject({ files, esbuild, spec: { sourcemap: false } });
    const code = new TextDecoder().decode(out.files.get("/worker.js"));
    expect(code).toContain("litestream|cf");
    const mod = await import(`data:text/javascript,${encodeURIComponent(code)}`);
    expect(typeof mod.K).toBe("function");
    const res = await mod.default.fetch(new Request("http://x/"), { DB: undefined }, {});
    expect(await res.text()).toBe("ok");
    expect(await readText(files, "/index.js")).toContain("export class K"); // sources untouched
  });
});
