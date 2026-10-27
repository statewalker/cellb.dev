import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  applyNodeD1Migrations,
  bundleWorkerForBrowser,
  loadNodeProject,
  nodeSqliteOpener,
} from "../src/node.js";

// Worker code is bundled from a FilesApi (webrun-bundler): a project need not be on disk, its
// TypeScript and packages are read through the FilesApi, and the bundle carries a source map
// back to them.

const enc = new TextEncoder();
async function project(tree: Record<string, string>) {
  const files = new MemFilesApi();
  for (const [path, text] of Object.entries(tree)) await files.write(path, [enc.encode(text)]);
  return files;
}

const CONFIG = {
  name: "mem-project",
  main: "src/index.ts",
  compatibility_date: "2026-10-01",
  vars: { GREETING: "hi" },
  d1_databases: [{ binding: "DB", database_name: "main", database_id: "x" }],
};

const WORKER = `import { env } from "cloudflare:workers";
import { shout } from "shouter";

interface Reply { greeting: string; }

export default {
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/stack") return new Response(new Error("here").stack);
    const reply: Reply = { greeting: shout(env.GREETING as string) };
    return Response.json(reply);
  },
};
`;

const TREE = {
  "/wrangler.json": JSON.stringify(CONFIG),
  "/src/index.ts": WORKER,
  "/node_modules/shouter/package.json": JSON.stringify({
    name: "shouter",
    version: "1.0.0",
    main: "index.js",
  }),
  "/node_modules/shouter/index.js": "exports.shout = (s) => s.toUpperCase() + '!';\n",
  "/migrations/0001_init.sql": "CREATE TABLE t (v TEXT);\n",
};

describe("P19 Worker code bundled from a FilesApi", () => {
  it("loads a project held in a MemFilesApi: TypeScript, a package, config and migrations", async () => {
    const files = await project(TREE);
    const { runtime, config } = await loadNodeProject(
      { files },
      { openSql: nodeSqliteOpener(), files: new MemFilesApi() },
    );
    try {
      expect(config.name).toBe("mem-project");
      const res = await runtime.fetch(new Request("http://x/"));
      expect(await res.json()).toEqual({ greeting: "HI!" });
      expect(await applyNodeD1Migrations({ files }, runtime, "main")).toEqual(["0001_init.sql"]);
      // The bundle names itself in stack traces (it is imported from a data: URL, no file):
      // V8's own formatting, which vitest's replaces (that one prints the data: URL).
      const E = Error as { prepareStackTrace?: unknown };
      const vitestFormat = E.prepareStackTrace;
      E.prepareStackTrace = undefined;
      const stack = await (await runtime.fetch(new Request("http://x/stack")))
        .text()
        .finally(() => {
          E.prepareStackTrace = vitestFormat;
        });
      expect(stack).toMatch(/cellb-worker:\/src\/index\.ts:\d+:\d+/);
    } finally {
      await runtime.close();
    }
  });

  it("a browser bundle from a FilesApi maps back to the project's files and its packages", async () => {
    const files = await project(TREE);
    const code = await bundleWorkerForBrowser({ files, entry: "/src/index.ts" });
    const b64 = /\/\/# sourceMappingURL=data:application\/json;base64,(\S+)/.exec(code)?.[1];
    const map = JSON.parse(Buffer.from(b64 as string, "base64").toString());
    expect(map.sources).toEqual(
      expect.arrayContaining([
        "~/src/index.ts",
        "npm:shouter@1.0.0/index.js",
        "virtual:cloudflare:workers",
      ]),
    );
    expect(map.sourcesContent[map.sources.indexOf("~/src/index.ts")]).toBe(WORKER);
    expect(code).toMatch(/\/\/# sourceURL=cellb-worker:\/src\/index\.ts\n$/);
  });
});
