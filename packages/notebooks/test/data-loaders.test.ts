// biome-ignore-all lint/suspicious/noTemplateCurlyInString: notebooks with `${…}` in SQL cells, as plain strings
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { DOMParser, parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  contentType,
  isDataPath,
  isServedSource,
  loaderProject,
  loaderTarget,
} from "../src/data-loaders.js";
import { buildPageModels } from "../src/page-models.js";

describe("loaderTarget", () => {
  it("names the data file a loader produces", () => {
    expect(loaderTarget("/data/sales.csv.js")).toBe("/data/sales.csv");
    expect(loaderTarget("/quakes.json.ts")).toBe("/quakes.json");
    expect(loaderTarget("/a.parquet.mjs")).toBe("/a.parquet");
  });

  it("leaves code, notebooks and plain files alone", () => {
    expect(loaderTarget("/lib/d3.min.js")).toBeUndefined();
    expect(loaderTarget("/x.worker.js")).toBeUndefined();
    expect(loaderTarget("/page.md.js")).toBeUndefined();
    expect(loaderTarget("/data.csv")).toBeUndefined();
    expect(loaderTarget("/helper.js")).toBeUndefined();
  });

  it("types data files", () => {
    expect(contentType("/a.csv")).toBe("text/csv; charset=utf-8");
    expect(contentType("/a.JSON")).toBe("application/json");
    expect(contentType("/a.unknown")).toBe("application/octet-stream");
  });
});

describe("isDataPath", () => {
  it("serves data, media and fonts by plain paths", () => {
    expect(isDataPath("/numbers.json")).toBe(true);
    expect(isDataPath("/data/photo.PNG")).toBe(true);
    expect(isServedSource("/data/sales.csv")).toBe(true);
  });

  it("never reaches a loader's or notebook's source, a dot-file or a code file", () => {
    for (const p of [
      "/numbers.json.js/.",
      "/numbers.json.js/x/..",
      "/x/../numbers.json.js",
      "/features.md/.",
      "/.env",
      "/.git/config",
      "/a//b.csv",
      "/config.secret.js",
      "/features.md",
      "/plots",
      "numbers.json",
    ])
      expect([p, isDataPath(p)]).toEqual([p, false]);
    // a loader produces data; its own source is not served
    expect(isServedSource("/numbers.json.js")).toBe(false);
  });
});

describe("loaderProject", () => {
  /** The project's entry, run in Node as the Worker Loader isolate runs it. */
  async function run(path: string, source: string) {
    const dir = mkdtempSync(join(tmpdir(), "nb-loader-"));
    for (const [name, text] of Object.entries(loaderProject(path, source)))
      writeFileSync(join(dir, name), text);
    const main = await import(pathToFileURL(join(dir, "main.js")).href);
    return (main.default as { fetch(): Promise<Response> }).fetch();
  }

  it("is a Worker whose fetch answers with the loader's data", async () => {
    const files = loaderProject("/data/x.json.js", "export default 1;");
    expect(JSON.parse(files["wrangler.json"] as string)).toMatchObject({ main: "main.js" });
    expect(Object.keys(files).sort()).toEqual(["loader.js", "main.js", "wrangler.json"]);
    expect(Object.keys(loaderProject("/x.csv.ts", ""))).toContain("loader.ts");
  });

  it("writes a value as JSON, and strings, bytes and Responses as they are", async () => {
    const json = await run("/a.json.js", "export default async () => ({ n: [1, 2] });");
    expect(await json.json()).toEqual({ n: [1, 2] });
    expect(await (await run("/a.csv.js", 'export default "a,b\\n1,2\\n";')).text()).toBe(
      "a,b\n1,2\n",
    );
    const bin = await run("/a.bin.js", "export default () => new Uint8Array([1, 2, 3]);");
    expect([...new Uint8Array(await bin.arrayBuffer())]).toEqual([1, 2, 3]);
    const res = await run("/a.txt.js", 'export default () => new Response("hi");');
    expect(await res.text()).toBe("hi");
  });

  it("answers 500 with the error when the loader throws or gives nothing", async () => {
    const thrown = await run("/a.json.js", 'export default () => { throw new Error("no API"); };');
    expect(thrown.status).toBe(500);
    expect(await thrown.text()).toContain("no API");
    const none = await run("/a.json.js", "export const x = 1;");
    expect(none.status).toBe(500);
    expect(await none.text()).toContain("gave no data");
  });
});

const moduleServer = {
  resolve: async (ref: { pkg: string; subpath?: string }) => ({
    url: `/m/${ref.pkg}@1.0.0/${ref.subpath ?? "index"}.js`,
    target: "browser",
  }),
};
const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");

describe("data files in pages", () => {
  it("registers the data files a page's cells name, at their URLs", async () => {
    const notebooks = new MemFilesApi({
      initialFiles: {
        "/guide/plots.md":
          '# P\n\n```js\nconst a = FileAttachment("../numbers.json").json();\n```\n\n' +
          "```js\nconst b = FileAttachment('data/x.csv').csv();\n```\n",
        "/index.md": "# Home\n",
      },
    });
    const models = await buildPageModels({
      notebooks,
      moduleServer,
      dom: { document, parser: new DOMParser() } as never,
      siteTitle: "S",
      base: "/t",
      dataFiles: ["/numbers.json", "/guide/data/x.csv", "/unused.csv"],
    });
    const plots = models.pages.find((p) => p.id === "guide/plots");
    expect(plots?.script).toContain("import {define, registerFile} from");
    expect(plots?.script).toContain('registerFile("../numbers.json", {"path":"/t/numbers.json"});');
    expect(plots?.script).toContain('registerFile("data/x.csv", {"path":"/t/guide/data/x.csv"});');
    expect(plots?.script).not.toContain("unused");
    const home = models.pages.find((p) => p.id === "index");
    expect(home?.script).not.toContain("registerFile");
  });

  it("registers a file named `./`-relative or from the site's root", async () => {
    const notebooks = new MemFilesApi({
      initialFiles: {
        "/guide/p.md":
          '# P\n\n```js\nconst a = FileAttachment("./data/x.csv");\n```\n\n' +
          '```js\nconst b = FileAttachment("/numbers.json");\n```\n',
      },
    });
    const models = await buildPageModels({
      notebooks,
      moduleServer,
      dom: { document, parser: new DOMParser() } as never,
      siteTitle: "S",
      base: "/t",
      dataFiles: ["/numbers.json", "/guide/data/x.csv"],
    });
    const script = models.pages[0]?.script ?? "";
    expect(script).toContain('registerFile("./data/x.csv", {"path":"/t/guide/data/x.csv"});');
    expect(script).toContain('registerFile("/numbers.json", {"path":"/t/numbers.json"});');
  });
});

describe("page paths", () => {
  it("puts a nested index page at its directory", async () => {
    const notebooks = new MemFilesApi({
      initialFiles: { "/index.md": "# Home\n", "/guide/index.md": "# Guide\n" },
    });
    const models = await buildPageModels({
      notebooks,
      moduleServer,
      dom: { document, parser: new DOMParser() } as never,
      siteTitle: "S",
      base: "/t",
    });
    expect(models.site.pages.map((p) => [p.id, p.path])).toEqual([
      ["index", "/t/"],
      ["guide/index", "/t/guide/"],
    ]);
  });
});

describe("SQL cells", () => {
  it("lists the cells on named databases, and which interpolate", async () => {
    const md = [
      "# Q",
      "",
      "```sql database=warehouse output=sales",
      "SELECT region FROM sales",
      "```",
      "",
      "```sql database=warehouse",
      "SELECT * FROM sales WHERE region = ${region}",
      "```",
      "",
      "```sql database=var:db",
      "SELECT 1",
      "```",
      "",
      "```sql",
      "SELECT 2",
      "```",
      "",
      "```sql database=warehouse run=false",
      "SELECT 3",
      "```",
    ].join("\n");
    const models = await buildPageModels({
      notebooks: new MemFilesApi({ initialFiles: { "/guide/q.md": md } }),
      moduleServer,
      dom: { document, parser: new DOMParser() } as never,
      siteTitle: "S",
      base: "/t",
    });
    expect(models.queries.map((q) => [q.page, q.database, q.strings, q.error])).toEqual([
      ["/t/guide/q", "warehouse", ["SELECT region FROM sales"], undefined],
      [
        "/t/guide/q",
        "warehouse",
        undefined,
        "the query interpolates a value known only in the page: not precomputed",
      ],
    ]);
  });

  it("hashes the strings the page's template passes, escapes cooked", async () => {
    const cell = (sql: string) => `\`\`\`sql database=w\n${sql}\n\`\`\``;
    const md = ["# Q", cell("SELECT 'a\\nb', '`', '$\\{x}'"), cell("SELECT 'C:\\users'")].join(
      "\n\n",
    );
    const models = await buildPageModels({
      notebooks: new MemFilesApi({ initialFiles: { "/q.md": md } }),
      moduleServer,
      dom: { document, parser: new DOMParser() } as never,
      siteTitle: "S",
    });
    const [escapes, invalid] = models.queries;
    // the source holds a backslash and an n; the page's template cooks them into a newline
    expect(escapes?.source).toBe("SELECT 'a\\nb', '`', '$\\{x}'");
    expect(escapes?.strings).toEqual(["SELECT 'a\nb', '`', '${x}'"]);
    expect(invalid?.strings).toBeUndefined();
    expect(invalid?.error).toContain("invalid escape");
  });
});
