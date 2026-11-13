// workerd behaviours that Kitesurf (Cloudflare's browser engine Worker) depends on, each checked
// on Node: a class as the default export, CommonJS modules in loaded Workers, abortIsolate(),
// stub.dup(), Request/Response/Headers/ReadableStream crossing an isolate, a writable
// `navigator` in an isolate, and Uint8Array's base64/hex methods.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterEach, describe, expect, it } from "vitest";
import { createCellRuntime, WorkerEntrypoint } from "../src/index.js";
import { loadNodeProject, nodeSqliteOpener } from "../src/node.js";
import { FakeClock } from "./fake-clock.js";

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
    writeFileSync(join(dir, path), contents);
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
