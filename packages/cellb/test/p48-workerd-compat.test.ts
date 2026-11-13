// workerd behaviours that Kitesurf (Cloudflare's browser engine Worker) depends on, each checked
// on Node: a class as the default export, CommonJS modules in loaded Workers, abortIsolate(),
// stub.dup(), Request/Response/Headers/ReadableStream crossing an isolate, a writable
// `navigator` in an isolate, and Uint8Array's base64/hex methods.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterEach, describe, expect, it } from "vitest";
import { createCellRuntime, WorkerEntrypoint } from "../src/index.js";
import { loadNodeProject, nodeSqliteOpener } from "../src/node.js";
import { FakeClock } from "./fake-clock.js";

const FIXTURE = join(import.meta.dirname, "fixtures/wasm-modules");
const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.close();
});

/** A project folder: wrangler.jsonc from `config`, then `files`. */
async function project(files: Record<string, string>, config: object = {}, host: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cellb-workerd-"));
  const all = {
    "wrangler.jsonc": JSON.stringify({
      name: "w",
      main: "index.js",
      compatibility_date: "2026-01-01",
      worker_loaders: [{ binding: "LOADER" }],
      ...config,
    }),
    ...files,
  };
  for (const [path, contents] of Object.entries(all)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(
      join(dir, path),
      path.endsWith(".wasm") ? Buffer.from(contents, "latin1") : contents,
    );
  }
  const { runtime } = await loadNodeProject(dir, {
    openSql: nodeSqliteOpener(),
    files: new MemFilesApi(),
    ...host,
  });
  running.push(runtime);
  return runtime;
}

/** index.js that loads `modules` (main.js first) as loaded Worker `id` and runs `body`. */
const withLoaded = (modules: Record<string, unknown>, body: string, head = "") => ({
  "index.js": `${head}
const MODULES = ${JSON.stringify(modules)};
const load = (env, id = "child") =>
  env.LOADER.get(id, () => ({ compatibilityDate: "2026-01-01", mainModule: "main.js", modules: MODULES }));
export default { async fetch(request, env) {
  try { ${body} } catch (e) { return Response.json({ error: String(e?.message ?? e) }); }
} };`,
});

const json = async (runtime: { fetch(r: Request): Promise<Response> }, path = "/") =>
  (await runtime.fetch(new Request(`http://w${path}`))).json();

describe("P48 workerd behaviours", () => {
  describe("a class as the default export (export default class extends WorkerEntrypoint)", () => {
    it("serves fetch with a fresh instance per request, built with (ctx, env)", async () => {
      let instances = 0;
      class Main extends WorkerEntrypoint<{ GREETING: string }> {
        n = ++instances;
        async fetch(req: Request) {
          const props = (this.ctx as { props?: unknown }).props;
          return Response.json({ greeting: this.env.GREETING, url: req.url, n: this.n, props });
        }
      }
      const runtime = createCellRuntime({
        worker: { default: Main },
        openSql: nodeSqliteOpener(),
        vars: { GREETING: "hi" },
      });
      running.push(runtime);
      expect(await json(runtime, "/a")).toEqual({
        greeting: "hi",
        url: "http://w/a",
        n: 1,
        props: {},
      });
      expect((await json(runtime, "/b")).n).toBe(2);
    });

    it("gets the requests the static assets do not answer", async () => {
      const runtime = await project(
        {
          "public/hello.txt": "from assets",
          "index.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  fetch(req) { return new Response("from the worker: " + new URL(req.url).pathname); }
}`,
        },
        { assets: { directory: "public" }, worker_loaders: [] },
      );
      expect(await (await runtime.fetch(new Request("http://w/hello.txt"))).text()).toBe(
        "from assets",
      );
      expect(await (await runtime.fetch(new Request("http://w/other"))).text()).toBe(
        "from the worker: /other",
      );
    });
    it("runs scheduled() of the class on a fresh instance for each cron occurrence", async () => {
      const clock = new FakeClock(Date.parse("2026-01-01T00:00:30Z"));
      const runtime = await project(
        {
          "index.js": `import { WorkerEntrypoint } from "cloudflare:workers";
const runs = [];
export default class extends WorkerEntrypoint {
  scheduled(controller) { runs.push({ cron: controller.cron, at: new Date(controller.scheduledTime).toISOString(), env: this.env.NAME }); }
  fetch() { return Response.json(runs); }
}`,
        },
        { worker_loaders: [], triggers: { crons: ["* * * * *"] }, vars: { NAME: "w" } },
        { clock },
      );
      await clock.advance(60_000);
      expect(await json(runtime)).toEqual([
        { cron: "* * * * *", at: "2026-01-01T00:01:00.000Z", env: "w" },
      ]);
    });
  });

  describe("CommonJS modules ({ cjs }) in a loaded Worker", () => {
    it("imports module.exports as the default export, in sloppy mode, with this = module.exports", async () => {
      const runtime = await project(
        withLoaded(
          {
            "main.js": {
              js: `import { WorkerEntrypoint } from "cloudflare:workers";
import lib from "./lib.cjs";
export default class extends WorkerEntrypoint { info() { return lib.info(); } }`,
            },
            "lib.cjs": {
              cjs: `implicitGlobal = 7; // an undeclared assignment: a ReferenceError in strict mode
var self = this;
module.exports.info = function () {
  return { sloppy: (function () { return this === undefined; })() === false,
           thisIsExports: self === module.exports, implicitGlobal: globalThis.implicitGlobal };
};`,
            },
          },
          "return Response.json(await load(env).getEntrypoint().info());",
        ),
      );
      expect(await json(runtime)).toEqual({ sloppy: true, thisIsExports: true, implicitGlobal: 7 });
    });
    it("reaches sibling modules: import() of an ES module, require() of CommonJS and ES modules", async () => {
      const runtime = await project(
        withLoaded(
          {
            "main.js": {
              js: `import { WorkerEntrypoint } from "cloudflare:workers";
import lib from "./lib.cjs";
export default class extends WorkerEntrypoint { async info() { return await lib.info(); } }`,
            },
            "state.js": { js: "export const state = { from: 'esm' };" },
            "helper.cjs": { cjs: "module.exports = { twice: (n) => n * 2 };" },
            "lib.cjs": {
              cjs: `const helper = require("./helper.cjs");
const esm = require("./state.js");
module.exports.info = async function () {
  const { state } = await import("./state.js");
  return { dynamic: state.from, twice: helper.twice(21), required: esm.state.from };
};`,
            },
          },
          "return Response.json(await load(env).getEntrypoint().info());",
        ),
      );
      expect(await json(runtime)).toEqual({ dynamic: "esm", twice: 42, required: "esm" });
    });
  });

  describe("import() in a loaded Worker resolves against its modules", () => {
    it("a computed specifier, and a module named by a URL, as Kitesurf loads page modules", async () => {
      const runtime = await project(
        withLoaded(
          {
            "main.js": {
              js: `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async load(spec) { return (await import(spec)).default; }
  async byUrl() { return (await import("https://example.test/app/index.js")).default; }
}`,
            },
            "pages/one.js": { js: "export default 'one';" },
            "https://example.test/app/index.js": {
              js: "import dep from './dep.js'; export default 'index+' + dep;",
            },
            "https://example.test/app/dep.js": { js: "export default 'dep';" },
          },
          `const c = load(env).getEntrypoint();
return Response.json({
  relative: await c.load("./pages/one.js"),
  exact: await c.load("pages/one.js"),
  url: await c.load("https://example.test/app/index.js"),
  literalUrl: await c.byUrl(),
});`,
        ),
      );
      expect(await json(runtime)).toEqual({
        relative: "one",
        exact: "one",
        url: "index+dep",
        literalUrl: "index+dep",
      });
    });

    it("from code built with Function (Kitesurf's importModule), in an isolate", async () => {
      const runtime = await project(
        withLoaded(
          {
            "main.js": {
              js: `import { WorkerEntrypoint } from "cloudflare:workers";
const dynamicImport = new (async () => {}).constructor("spec", "return await import(spec);");
export default class extends WorkerEntrypoint {
  async load(spec) {
    const ns = await dynamicImport(spec);
    return { value: ns.default, named: ns.answer ?? null, star: ns.fromStar ?? null };
  }
}`,
            },
            "https://example.test/app/index.js": {
              js: "export * from './more.js'; export const answer = 42; export default 'index';",
            },
            "https://example.test/app/more.js": { js: "export const fromStar = 'star';" },
            "__ks_user_classic_async.js": { cjs: "module.exports.run = () => 'ran';" },
          },
          `const c = load(env).getEntrypoint();
return Response.json({
  url: await c.load("https://example.test/app/index.js"),
  relative: await c.load("./__ks_user_classic_async.js"),
});`,
        ),
      );
      expect(await json(runtime)).toEqual({
        url: { value: "index", named: 42, star: "star" },
        relative: { value: { run: {} }, named: null, star: null },
      });
    });

    it("routes only the calls a bundler cannot link (unit)", async () => {
      const { routeDynamicImports, resolveModuleName } = await import(
        "../src/bindings/module-registry.js"
      );
      const src = `const a = import("./rel.js");\nconst b = import(spec);\nconst c = import("https://x/y.js"); // import(no)`;
      expect(routeDynamicImports(src, "dir/m.js")).toBe(
        `const a = import("./rel.js");\nconst b = __cellbImportFrom(spec, "dir/m.js");\nconst c = __cellbImportFrom("https://x/y.js", "dir/m.js"); // import(no)`,
      );
      expect(routeDynamicImports("export const x = 1;", "m.js")).toBeUndefined();
      const names = new Set(["dir/a.js", "https://x/y.js", "b.js"]);
      expect(resolveModuleName("./a.js", "dir/m.js", names)).toBe("dir/a.js");
      expect(resolveModuleName("../b.js", "dir/m.js", names)).toBe("b.js");
      expect(resolveModuleName("https://x/y.js", "dir/m.js", names)).toBe("https://x/y.js");
      expect(resolveModuleName("node:fs", "dir/m.js", names)).toBeUndefined();
    });

    it("rewrites import() in a Function body, keeping everything else (unit)", async () => {
      const { routeBodyImports } = await import("../src/isolate/function-imports.js");
      expect(routeBodyImports(["spec"], "return await import(spec);", "async function")).toBe(
        "return await __cellbFunctionImport(spec);",
      );
      expect(routeBodyImports([], "const s = 'import(x)'; return 1;", "function")).toBe(
        "const s = 'import(x)'; return 1;",
      );
      expect(routeBodyImports([], "return import(", "function")).toBe("return import(");
    });

    it("collects each module's export names, following export * within the modules (unit)", async () => {
      const { exportNamesByModule } = await import("../src/bindings/module-registry.js");
      expect(
        exportNamesByModule({
          "a.js":
            "export * from './b.js'; export const { x, y: [z] } = o; export default 1; const q = 3; export { q as 'odd name' };",
          "b.js":
            "export function f() {} export class C {} export * as ns from './c.js'; export default 2;",
          "c.js": "export let v;",
        })["a.js"].sort(),
      ).toEqual(["C", "default", "f", "ns", "odd name", "x", "z"].sort());
    });
  });

  describe("wasm modules of loaded Workers", () => {
    it("compile once per bytes object, however many Workers load them", async () => {
      const compile = WebAssembly.compile;
      let compiles = 0;
      WebAssembly.compile = (bytes) => {
        compiles++;
        return compile(bytes);
      };
      try {
        const runtime = await project(
          {
            "add.wasm": readFileSync(join(FIXTURE, "add.wasm")).toString("latin1"),
            "index.js": `import fs from "node:fs";
const WASM = new Uint8Array(fs.readFileSync("/bundle/" + fs.readdirSync("/bundle").find((n) => n.endsWith("-add.wasm")))).buffer;
import "./add.wasm";
const code = { compatibilityDate: "2026-01-01", mainModule: "main.js", modules: {
  "main.js": "import m from './add.wasm'; import { WorkerEntrypoint } from 'cloudflare:workers'; export default class extends WorkerEntrypoint { add(a, b) { return new WebAssembly.Instance(m).exports.add(a, b); } }",
  "add.wasm": { wasm: WASM },
} };
export default { async fetch(req, env) {
  const a = await env.LOADER.get("one", () => code).getEntrypoint().add(1, 2);
  const b = await env.LOADER.get("two", () => code).getEntrypoint().add(20, 22);
  return Response.json([a, b]);
} };`,
          },
          { compatibility_flags: ["nodejs_compat"] },
        );
        expect(await json(runtime)).toEqual([3, 42]);
        expect(compiles).toBe(1);
      } finally {
        WebAssembly.compile = compile;
      }
    });
  });

  describe("what loaded code may leave unresolved (it fails when it runs, as on workerd)", () => {
    it("an optional or missing require() throws where it is called, and a catch handles it", async () => {
      const runtime = await project(
        withLoaded(
          {
            "main.js": {
              js: `import { WorkerEntrypoint } from "cloudflare:workers";
import lib from "./lib.cjs";
export default class extends WorkerEntrypoint { info() { return lib; } }`,
            },
            "lib.cjs": {
              cjs: `let optional = "absent";
try { optional = require("some-optional-package"); } catch { }
let sibling = "absent";
try { sibling = require("./not-there.js"); } catch { }
module.exports = { optional, sibling };`,
            },
          },
          "return Response.json(await load(env).getEntrypoint().info());",
        ),
      );
      expect(await json(runtime)).toEqual({ optional: "absent", sibling: "absent" });
    });

    it("a module nothing imports may import something unresolvable", async () => {
      const runtime = await project(
        withLoaded(
          {
            "main.js": {
              js: `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  ok() { return "ok"; }
  async broken() { try { await import("./unused.js"); return "loaded"; } catch { return "failed when imported"; } }
}`,
            },
            "unused.js": {
              js: "import x from 'no-such-package'; import y from './no-such-file.js'; export default x + y;",
            },
          },
          `const c = load(env).getEntrypoint();
return Response.json([await c.ok(), await c.broken()]);`,
        ),
      );
      expect(await json(runtime)).toEqual(["ok", "failed when imported"]);
    });
  });

  describe("abortIsolate() in a loaded Worker", () => {
    // workerd's worker-loader-test.js abortIsolateDynamic, as a project.
    it("ends the isolate: the call rejects with workerd's error, and the next get() loads it again", async () => {
      const runtime = await project(
        withLoaded(
          {
            "main.js": {
              js: `import { WorkerEntrypoint, abortIsolate } from "cloudflare:workers";
let counter = 0;
export class TestEntrypoint extends WorkerEntrypoint {
  async crash() { abortIsolate("Dynamic worker abort test"); }
  async ping() { return ++counter; }
}`,
            },
          },
          `let loads = 0;
const entry = () => env.LOADER.get("abort-test", () => {
  loads++;
  return { compatibilityDate: "2026-01-01", mainModule: "main.js", modules: MODULES };
}).getEntrypoint("TestEntrypoint");
const out = [await entry().ping(), await entry().ping(), loads];
let error;
try { await entry().crash(); } catch (e) { error = String(e.message); }
out.push(error.startsWith("internal error; reference ="));
out.push(await entry().ping(), await entry().ping(), loads);
return Response.json(out);`,
        ),
      );
      expect(await json(runtime)).toEqual([1, 2, 1, true, 1, 2, 2]);
    }, 30_000);
  });

  describe("stub.dup()", () => {
    it("in an isolate: a copy of a callback stub outlives the original's disposal", async () => {
      const runtime = await project(
        withLoaded(
          {
            "main.js": {
              js: `import { WorkerEntrypoint } from "cloudflare:workers";
let kept;
export default class extends WorkerEntrypoint {
  keep(callback) { kept = callback.dup(); callback[Symbol.dispose](); return typeof kept; }
  async use() { return await kept("later"); }
}`,
            },
          },
          `const child = load(env).getEntrypoint();
const kind = await child.keep((s) => "called " + s);
return Response.json({ kind, result: await child.use() });`,
        ),
      );
      expect(await json(runtime)).toEqual({ kind: "function", result: "called later" });
    });

    it("on a loaded Worker's entrypoint: itself, still callable", async () => {
      const runtime = await project(
        withLoaded(
          {
            "main.js": {
              js: "import { WorkerEntrypoint } from 'cloudflare:workers'; export default class extends WorkerEntrypoint { hi() { return 'hi'; } }",
            },
          },
          `const entry = load(env).getEntrypoint();
const copy = entry.dup();
return Response.json({ same: copy === entry, hi: await copy.hi() });`,
        ),
      );
      expect(await json(runtime)).toEqual({ same: true, hi: "hi" });
    });

    it("on a Durable Object stub: the stub itself", async () => {
      const runtime = await project(
        {
          "index.js": `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject { hi() { return "hi"; } }
export default { async fetch(req, env) {
  const stub = env.COUNTER.getByName("a");
  return Response.json({ same: stub.dup() === stub, hi: await stub.dup().hi() });
} };`,
        },
        {
          worker_loaders: [],
          durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["Counter"] }],
        },
      );
      expect(await json(runtime)).toEqual({ same: true, hi: "hi" });
    });
  });

  describe("Request, Response, Headers and ReadableStream across an isolate", () => {
    const child = {
      "main.js": {
        js: `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async describe(request, headers) {
    return { method: request.method, url: request.url, body: await request.text(),
             header: headers.get("x-a"), isHeaders: headers instanceof Headers };
  }
  respond() {
    return new Response("made in the isolate", { status: 201, headers: { "x-from": "isolate" } });
  }
  async callBack(fetcher) {
    const res = await fetcher({ url: "https://example.test/font", headers: new Headers({ accept: "font/otf" }) });
    return { status: res.status, type: res.headers.get("content-type"), text: await res.text() };
  }
  async cancelBody(fetcher) { const res = await fetcher(); await res.body.cancel(); return res.status; }
  async stream(readable) {
    let text = "";
    for await (const chunk of readable.pipeThrough(new TextDecoderStream())) text += chunk;
    return text;
  }
}`,
      },
    };

    it("cross as arguments and results, with their bodies", async () => {
      const runtime = await project(
        withLoaded(
          child,
          `const c = load(env).getEntrypoint();
const described = await c.describe(
  new Request("https://example.test/p", { method: "POST", body: "payload" }),
  new Headers({ "x-a": "1" }),
);
const res = await c.respond();
const fromIsolate = { status: res.status, header: res.headers.get("x-from"), text: await res.text(), isResponse: res instanceof Response };
const callBack = await c.callBack(async (init) => new Response("bytes for " + init.url + " " + init.headers.get("accept"), { headers: { "content-type": "font/otf" } }));
return Response.json({ described, fromIsolate, callBack });`,
        ),
      );
      expect(await json(runtime)).toEqual({
        described: {
          method: "POST",
          url: "https://example.test/p",
          body: "payload",
          header: "1",
          isHeaders: true,
        },
        fromIsolate: {
          status: 201,
          header: "isolate",
          text: "made in the isolate",
          isResponse: true,
        },
        callBack: {
          status: 200,
          type: "font/otf",
          text: "bytes for https://example.test/font font/otf",
        },
      });
    });

    it("a Request with a streamed body needs no duplex option, as on workerd", async () => {
      const runtime = await project(
        withLoaded(
          {
            "main.js": {
              js: `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async post() {
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("streamed")); c.close(); } });
    return await new Request("https://example.test/", { method: "POST", body }).text();
  }
}`,
            },
          },
          `const inProject = await new Request("https://example.test/", {
  method: "POST",
  body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("here too")); c.close(); } }),
}).text();
return Response.json({ inIsolate: await load(env).getEntrypoint().post(), inProject });`,
        ),
      );
      expect(await json(runtime)).toEqual({ inIsolate: "streamed", inProject: "here too" });
    });

    it("Response.error() crosses as an error response, not a failed call", async () => {
      const runtime = await project(
        withLoaded(
          {
            "main.js": {
              js: "import { WorkerEntrypoint } from 'cloudflare:workers'; export default class extends WorkerEntrypoint { fail() { return Response.error(); } }",
            },
          },
          `const res = await load(env).getEntrypoint().fail();
return Response.json({ type: res.type, status: res.status, ok: res.ok });`,
        ),
      );
      expect(await json(runtime)).toEqual({ type: "error", status: 0, ok: false });
    });

    it("new Request(url, request) keeps the request's method, headers and streamed body", async () => {
      const runtime = await project(
        withLoaded(
          { "main.js": { js: "export default {};" } },
          `const original = new Request("https://a.test/", {
  method: "PUT",
  headers: { "x-a": "1" },
  body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("moved")); c.close(); } }),
});
const copy = new Request("https://b.test/", original);
return Response.json({ method: copy.method, header: copy.headers.get("x-a"), body: await copy.text() });`,
        ),
      );
      expect(await json(runtime)).toEqual({ method: "PUT", header: "1", body: "moved" });
    });

    it("streams a body chunk by chunk, and releases one cancelled unread", async () => {
      const runtime = await project(
        withLoaded(
          child,
          `const c = load(env).getEntrypoint();
let pulled = 0;
let cancelled;
const cancelledP = new Promise((r) => (cancelled = r));
const readable = new ReadableStream({
  pull(controller) {
    pulled++;
    if (pulled <= 3) controller.enqueue(new TextEncoder().encode("chunk" + pulled + ";"));
    else controller.close();
  },
});
const streamed = await c.stream(readable);
const status = await c.cancelBody(async () => new Response(new ReadableStream({
  pull(controller) { controller.enqueue(new Uint8Array(1)); },
  cancel() { cancelled("cancelled"); },
})));
// The isolate cancelled the body before reading any of it: the stream here hears it.
const released = await Promise.race([cancelledP, new Promise((r) => setTimeout(() => r("not released"), 2000))]);
return Response.json({ streamed, status, released });`,
        ),
      );
      expect(await json(runtime)).toEqual({
        streamed: "chunk1;chunk2;chunk3;",
        status: 200,
        released: "cancelled",
      });
    });
  });

  describe("workerd's /bundle in node:fs (nodejs_compat)", () => {
    const files = {
      "add.wasm": readFileSync(join(FIXTURE, "add.wasm")).toString("latin1"),
      "greeting.md": "hello from a text module",
      "index.js": `import fs from "node:fs";
import { readdir } from "node:fs/promises";
import wasm from "./add.wasm";
import greeting from "./greeting.md";
export default { async fetch() {
  const names = fs.readdirSync("/bundle");
  const wasmName = names.find((n) => n.endsWith("-add.wasm"));
  const bytes = fs.readFileSync("/bundle/" + wasmName);
  const { add } = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports;
  let missing;
  try { fs.readFileSync("/bundle/nope.wasm"); } catch (e) { missing = e.code; }
  return Response.json({
    names: names.map((n) => n.replace(/^[0-9a-f]{40}-/, "<sha1>-")).sort(),
    sha1Named: names.every((n) => /^[0-9a-f]{40}-/.test(n)),
    sum: add(2, 40),
    sameModule: wasm instanceof WebAssembly.Module,
    text: fs.readFileSync("/bundle/" + names.find((n) => n.endsWith("-greeting.md")), "utf8") === greeting,
    isDir: fs.statSync("/bundle").isDirectory(),
    exists: fs.existsSync("/bundle/" + wasmName),
    missing,
    viaPromises: (await readdir("/bundle")).length === names.length,
    elsewhere: fs.existsSync("/definitely/not/here"),
    probe: fs.statSync("/bundle/nope.wasm", { throwIfNoEntry: false }) === undefined,
  });
} };`,
    };
    const config = {
      worker_loaders: [],
      compatibility_flags: ["nodejs_compat"],
      rules: [{ type: "Text", globs: ["**/*.md"] }],
    };

    it("on Node: lists and reads the bundle's non-JS modules, named <sha1>-<file> as wrangler uploads them", async () => {
      const runtime = await project(files, config);
      expect(await json(runtime)).toEqual({
        names: ["<sha1>-add.wasm", "<sha1>-greeting.md"],
        sha1Named: true,
        sum: 42,
        sameModule: true,
        text: true,
        isDir: true,
        exists: true,
        missing: "ENOENT",
        viaPromises: true,
        elsewhere: false,
        probe: true,
      });
    });

    it("in a browser's node:fs (no file system): /bundle is the one directory there is", async () => {
      const { registerBundleFile } = await import("../src/node-compat/bundle-files.js");
      const fs = await import("../src/node-compat/fs.js");
      registerBundleFile(
        "0123456789012345678901234567890123456789-x.bin",
        new Uint8Array([1, 2, 3]),
      );
      expect(fs.readdirSync("/bundle")).toContain("0123456789012345678901234567890123456789-x.bin");
      expect([
        ...(fs.readFileSync(
          "/bundle/0123456789012345678901234567890123456789-x.bin",
        ) as Uint8Array),
      ]).toEqual([1, 2, 3]);
      expect(fs.existsSync("/etc/passwd")).toBe(false);
      expect(() => fs.readFileSync("/etc/passwd")).toThrow(/ENOENT/);
      expect(() => fs.readFileSync("/bundle/missing")).toThrow(/ENOENT/);
    });
  });

  describe("an isolate's globals", () => {
    it("lets loaded code assign navigator, and has Uint8Array base64/hex methods", async () => {
      const runtime = await project(
        withLoaded(
          {
            "main.js": {
              js: `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  run() {
    "use strict";
    globalThis.navigator = { userAgent: "kitesurf" };
    const bytes = new Uint8Array([104, 105, 255]);
    return { ua: navigator.userAgent, b64: bytes.toBase64(), url: bytes.toBase64({ alphabet: "base64url", omitPadding: true }),
             hex: bytes.toHex(), back: [...Uint8Array.fromBase64("aGn/")], fromHex: [...Uint8Array.fromHex("6869ff")] };
  }
}`,
            },
          },
          `const inIsolate = await load(env).getEntrypoint().run();
return Response.json({ inIsolate, inProject: new Uint8Array([1, 2, 3]).toBase64() });`,
        ),
      );
      expect(await json(runtime)).toEqual({
        inIsolate: {
          ua: "kitesurf",
          b64: "aGn/",
          url: "aGn_",
          hex: "6869ff",
          back: [104, 105, 255],
          fromHex: [104, 105, 255],
        },
        inProject: "AQID",
      });
    });
  });
});
