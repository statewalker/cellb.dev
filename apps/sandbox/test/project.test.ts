import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createAppSite } from "../src/sandbox/app-site";
import {
  clientFilesOf,
  describeProject,
  encode,
  type ProjectFiles,
  rewriteHtml,
} from "../src/sandbox/project";

const SAMPLE = new URL("../sample/tasks/", import.meta.url).pathname;

async function readFolder(dir: string): Promise<ProjectFiles> {
  const files: ProjectFiles = new Map();
  async function walk(d: string) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else files.set(`/${relative(dir, p)}`, new Uint8Array(await readFile(p)));
    }
  }
  await walk(dir);
  return files;
}

const fileMap = (o: Record<string, string>): ProjectFiles =>
  new Map(Object.entries(o).map(([k, v]) => [k, encode(v)]));

describe("describeProject", () => {
  it("finds the server and the client parts of the sample", async () => {
    const layout = describeProject(await readFolder(SAMPLE), "tasks-folder");
    expect(layout.name).toBe("tasks");
    expect(layout.wranglerPath).toBe("/wrangler.jsonc");
    expect(layout.clientRoot).toBe("/client");
    expect(layout.problems).toEqual([]);
  });

  it("takes the client folder from wrangler's `client` field", () => {
    const layout = describeProject(
      fileMap({
        "/wrangler.jsonc": '{ "name": "x", "main": "w.ts", "client": "web" }',
        "/w.ts": "export default {}",
        "/web/index.html": "<p>hi</p>",
        "/client/index.html": "<p>not this one</p>",
      }),
    );
    expect(layout.clientRoot).toBe("/web");
  });

  it("runs a client-only folder from its root", () => {
    const layout = describeProject(fileMap({ "/index.html": "<p>hi</p>" }), "site");
    expect(layout).toMatchObject({ name: "site", clientRoot: "/", wranglerPath: undefined });
  });

  it("reports what it cannot run", () => {
    expect(describeProject(fileMap({ "/a.txt": "" })).problems[0]).toMatch(/no wrangler/);
    expect(
      describeProject(fileMap({ "/wrangler.jsonc": '{ "main": "missing.ts" }' })).problems[0],
    ).toMatch(/missing\.ts/);
  });
});

describe("rewriteHtml", () => {
  it("points local scripts at the module server, relative to the page", () => {
    const html = `<script type="module" src="./src/main.tsx"></script>
<script src="/lib/a.js?v=1"></script>
<script src="https://cdn.example/x.js"></script>
<script>console.log(1)</script>
<link rel="stylesheet" href="./src/styles.css">`;
    const out = rewriteHtml(html, "/index.html");
    expect(out).toContain('<script type="module" src="./_modules/~/src/main.tsx">');
    expect(out).toContain('<script type="module" src="./_modules/~/lib/a.js?v=1">');
    expect(out).toContain('src="https://cdn.example/x.js"');
    expect(out).toContain("<script>console.log(1)</script>");
    expect(out).toContain('href="./src/styles.css"');
    expect(rewriteHtml('<script src="app.ts"></script>', "/docs/page.html")).toContain(
      'src="../_modules/~/docs/app.ts"',
    );
  });
});

describe("createAppSite", () => {
  it("serves client files, compiled client modules, and the server", async () => {
    const files = await readFolder(SAMPLE);
    const layout = describeProject(files);
    const calls: string[] = [];
    const site = await createAppSite({
      client: clientFilesOf(files, layout.clientRoot as string),
      server: {
        async fetch(req) {
          calls.push(`${req.method} ${new URL(req.url).pathname} ${await req.text()}`);
          return Response.json([]);
        },
      },
    });
    const get = (path: string, init?: RequestInit) => site(new Request(`http://site${path}`, init));

    const page = await get("/");
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(await page.text()).toContain('src="./_modules/~/src/main.tsx"');

    const css = await get("/src/styles.css");
    expect(css.headers.get("content-type")).toMatch(/text\/css/);

    const main = await get("/_modules/~/src/main.tsx");
    expect(main.status).toBe(200);
    const code = await main.text();
    expect(code).toContain("~deps/react-dom/client.js");
    expect(code).not.toContain("useState<"); // TypeScript is gone

    const api = await get("/_modules/~/src/api.ts");
    expect(await api.text()).toContain("api/lists/");

    expect((await get("/package.json")).status).toBe(200); // not a client file: the server's
    await get("/api/lists/today/tasks", { method: "POST", body: '{"title":"x"}' });
    expect(calls).toEqual(["GET /package.json ", 'POST /api/lists/today/tasks {"title":"x"}']);
  });

  it("answers 404 for a missing file when there is no server", async () => {
    const site = await createAppSite({ client: fileMap({ "/index.html": "<p>hi</p>" }) });
    expect((await site(new Request("http://site/nope.js"))).status).toBe(404);
    expect(await (await site(new Request("http://site/"))).text()).toBe("<p>hi</p>");
  });
});

describe("a shared module cache", () => {
  it("serves the new sources on the next run, not the previous run's", async () => {
    const { MemFilesApi } = await import("@statewalker/webrun-files-mem");
    const moduleCache = new MemFilesApi();
    const page = { "/index.html": '<script src="main.ts"></script>' };
    const first = await createAppSite({
      client: fileMap({ ...page, "/main.ts": "export const v: number = 1;" }),
      moduleCache,
    });
    expect(await (await first(new Request("http://s/_modules/~/main.ts"))).text()).toContain(
      "v = 1",
    );
    const second = await createAppSite({
      client: fileMap({ ...page, "/main.ts": "export const v: number = 2;" }),
      moduleCache,
    });
    expect(await (await second(new Request("http://s/_modules/~/main.ts"))).text()).toContain(
      "v = 2",
    );
  });
});
