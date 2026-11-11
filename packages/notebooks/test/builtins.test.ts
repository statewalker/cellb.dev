import type { ModuleRef, ModuleServer } from "@statewalker/webrun-modules";
import { describe, expect, it } from "vitest";
import {
  builtinClosure,
  recommendedLibraries,
  staticImports,
  withLocalBuiltins,
} from "../src/builtins.js";

const BASE = "/nb/s/_m/";
const VERSIONS: Record<string, string> = {
  htl: "0.3.1",
  "@observablehq/inputs": "0.12.0",
  "@duckdb/duckdb-wasm": "1.32.0",
  "react-dom": "19.3.1",
};

/** A module server answering `resolve` from VERSIONS and `fetch` from `files`. */
function fakeServer(files: Record<string, string>): ModuleServer & { resolved: ModuleRef[] } {
  const resolved: ModuleRef[] = [];
  return {
    resolved,
    async resolve(ref) {
      resolved.push(ref);
      if (!("pkg" in ref) || !VERSIONS[ref.pkg]) throw new Error("no such package");
      const root = `${BASE}${ref.pkg}@${ref.version ?? VERSIONS[ref.pkg]}`;
      return { url: `${root}/${ref.subpath ?? "index"}.js`, target: "browser" } as never;
    },
    prime: async () => ({}) as never,
    listResources: async () => [],
    listPackageFiles: async () => [],
    lock: {} as never,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = files[path];
      if (body === undefined) return new Response("not found", { status: 404 });
      const type = path.endsWith(".css") ? "text/css" : "text/javascript";
      return new Response(body, { headers: { "content-type": type, "content-length": "1" } });
    },
  };
}

describe("withLocalBuiltins", () => {
  const files = {
    "/a.js": [
      'export * from "https://esm.sh/@observablehq/inputs";',
      'export const html = () => import("https://esm.sh/htl").then((_) => _.html);',
      'const w = "https://esm.sh/@duckdb/duckdb-wasm@1.32.0/dist/duckdb-browser-mvp.worker.js?raw";',
      'export const ReactDOM = () => import("https://esm.sh/react-dom@19.3.1/client?target=es2022");',
    ].join("\n"),
    "/b.css": '@import "https://esm.sh/@observablehq/inputs/dist/index.css";',
  };
  const ESM = `${BASE}~esm/`;

  it("rewrites esm.sh URLs to the site's ~esm/ URLs without resolving anything", async () => {
    const inner = fakeServer(files);
    const server = withLocalBuiltins(inner, BASE);
    const js = await (await server.fetch(new Request("http://x/a.js"))).text();
    expect(js).toContain(`export * from "${ESM}@observablehq/inputs";`);
    expect(js).toContain(`import("${ESM}htl")`);
    expect(js).toContain(
      `"${ESM}@duckdb/duckdb-wasm@1.32.0/dist/duckdb-browser-mvp.worker.js?raw"`,
    );
    expect(js).toContain(`import("${ESM}react-dom@19.3.1/client")`); // esm.sh's ?target dropped
    const css = await (await server.fetch(new Request("http://x/b.css"))).text();
    expect(css).toBe(`@import "${ESM}@observablehq/inputs/dist/index.css";`);
    // serving the files downloaded no package
    expect(inner.resolved).toEqual([]);
  });

  it("redirects a ~esm/ request to the package's pinned URL, resolving it then", async () => {
    const server = withLocalBuiltins(fakeServer(files), BASE);
    const at = async (path: string) =>
      (await server.fetch(new Request(`http://x${ESM}${path}`))).headers.get("location");
    expect(await at("htl")).toBe(`${BASE}htl@0.3.1/index.js`);
    expect(await at("react-dom@19.3.1/client")).toBe(`${BASE}react-dom@19.3.1/client.js`);
    // a file of the package keeps its path, and ?raw (a classic worker) stays
    expect(await at("@duckdb/duckdb-wasm@1.32.0/dist/duckdb-browser-mvp.worker.js?raw")).toBe(
      `${BASE}@duckdb/duckdb-wasm@1.32.0/dist/duckdb-browser-mvp.worker.js?raw`,
    );
    // a package the registry lacks goes to esm.sh, as before
    expect(await at("not-on-the-registry")).toBe("https://esm.sh/not-on-the-registry");
    expect(await server.resolveEsm(`${ESM}@observablehq/inputs/dist/index.css`)).toBe(
      `${BASE}@observablehq/inputs@0.12.0/dist/index.css`,
    );
  });

  it("drops the stale content-length and leaves other responses as they are", async () => {
    const server = withLocalBuiltins(fakeServer({ "/c.js": 'import "https://esm.sh/htl";' }), BASE);
    const res = await server.fetch(new Request("http://x/c.js"));
    expect(res.headers.get("content-length")).toBeNull();
    expect((await server.fetch(new Request("http://x/missing.js"))).status).toBe(404);
  });
});

describe("staticImports and recommendedLibraries", () => {
  it("finds static imports, not dynamic ones", () => {
    const src = `import { a } from "./a.js";\nexport * from "/m/b.js";\nimport "./c.css?module";\nconst d = () => import("./d.js");`;
    expect(staticImports(src).sort()).toEqual(["./a.js", "./c.css?module", "/m/b.js"]);
    expect(staticImports('@import "/m/x.css";')).toEqual(["/m/x.css"]);
  });

  it("reads notebook-kit's name → URL lines", () => {
    const libs = recommendedLibraries(
      'export const d3 = () => import("/m/d3@7/index.js");\nexport const Inputs = () => import("./inputs.js");\nexport const tex = () => import("./tex.js").then((_) => _.tex);',
    );
    expect([...libs]).toEqual([
      ["d3", "/m/d3@7/index.js"],
      ["Inputs", "./inputs.js"],
      ["tex", "./tex.js"],
    ]);
  });
});

describe("builtinClosure", () => {
  const files: Record<string, string> = {
    "/m/kit/dist/src/runtime/stdlib/recommendedLibraries.js": [
      'export const Inputs = () => import("./inputs.js");',
      'export const d3 = () => import("/m/d3@7/index.js");',
      'export const duckdb = () => import("/m/duckdb@1/index.js");',
    ].join("\n"),
    "/m/kit/dist/src/runtime/stdlib/inputs.js":
      'export * from "/m/inputs@1/index.js";\nimport "./inputs.css?module";',
    "/m/kit/dist/src/runtime/stdlib/inputs.css": ".inputs {}",
    "/m/inputs@1/index.js": 'import { html } from "/m/htl@0/index.js";',
    "/m/htl@0/index.js": "export const html = 1;",
    "/m/d3@7/index.js": "export {};",
  };
  const fetchText = async (url: string) => files[url];

  it("follows only the libraries the cells use, and their static imports", async () => {
    const { urls, names } = await builtinClosure({
      runtimeUrl: "/m/kit/dist/src/runtime/index.js",
      used: ["Inputs", "x", "width"],
      fetchText,
      have: () => false,
    });
    expect(names).toEqual(["Inputs"]);
    expect(urls).toEqual([
      "/m/kit/dist/src/runtime/stdlib/inputs.js",
      "/m/inputs@1/index.js",
      "/m/kit/dist/src/runtime/stdlib/inputs.css",
      "/m/htl@0/index.js",
    ]);
    expect(urls.some((u) => u.includes("duckdb") || u.includes("d3"))).toBe(false);
  });

  it("follows ~esm/ URLs to their targets and records them as aliases", async () => {
    const withEsm = {
      ...files,
      "/m/kit/dist/src/runtime/stdlib/recommendedLibraries.js":
        'export const htl = () => import("/m/~esm/htl");',
    };
    const { urls, aliases } = await builtinClosure({
      runtimeUrl: "/m/kit/dist/src/runtime/index.js",
      used: ["htl"],
      fetchText: async (url) => withEsm[url as keyof typeof withEsm],
      resolve: async (url) => (url === "/m/~esm/htl" ? "/m/htl@0/index.js" : undefined),
      have: () => false,
    });
    expect(urls).toEqual(["/m/htl@0/index.js"]);
    expect([...aliases]).toEqual([["/m/~esm/htl", "/m/htl@0/index.js"]]);
  });

  it("leaves out an import that does not load (a match in a comment or string)", async () => {
    const withGhost = {
      ...files,
      "/m/kit/dist/src/runtime/stdlib/recommendedLibraries.js":
        'export const d3 = () => import("/m/d3@7/index.js");',
      "/m/d3@7/index.js": '// usage: import { x } from "./not-a-file.js";\nexport {};',
    };
    const { urls } = await builtinClosure({
      runtimeUrl: "/m/kit/dist/src/runtime/index.js",
      used: ["d3"],
      fetchText: async (url) => withGhost[url as keyof typeof withGhost],
      have: () => false,
    });
    expect(urls).toEqual(["/m/d3@7/index.js"]);
  });

  it("skips what the export already holds", async () => {
    const { urls } = await builtinClosure({
      runtimeUrl: "/m/kit/dist/src/runtime/index.js",
      used: ["d3"],
      fetchText,
      have: (u) => u === "/m/d3@7/index.js",
    });
    expect(urls).toEqual([]);
  });
});
