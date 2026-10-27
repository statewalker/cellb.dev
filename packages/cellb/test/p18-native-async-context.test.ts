import { AsyncLocalStorage as NodeAls } from "node:async_hooks";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// In a realm with TC39 AsyncContext, cellb's node:async_hooks is a thin layer over it and
// nothing is lowered or patched: the engine carries the stores through native awaits, as in
// workerd, celld and Node. No browser ships AsyncContext yet, so this test gives the realm one
// built on Node's own (engine-backed) AsyncLocalStorage, and runs code with native awaits.

// biome-ignore lint/suspicious/noExplicitAny: any function, called with its own arguments
type Fn = (...args: any[]) => any;
class Variable<T> {
  #als = new NodeAls<T>();
  get(): T | undefined {
    return this.#als.getStore();
  }
  run<R>(value: T, fn: Fn, ...args: unknown[]): R {
    return this.#als.run(value, fn, ...args);
  }
}
class Snapshot {
  #run = NodeAls.snapshot();
  run<R>(fn: Fn, ...args: unknown[]): R {
    return this.#run(fn, ...args);
  }
  static wrap<F extends Fn>(fn: F): F {
    const s = new Snapshot();
    return function (this: unknown, ...args: unknown[]) {
      return s.run(() => fn.apply(this, args));
    } as F;
  }
}

const g = globalThis as { AsyncContext?: unknown };
let hooks: typeof import("../src/node-compat/async_hooks.js");
const thenBefore = Promise.prototype.then;
beforeAll(async () => {
  g.AsyncContext = { Variable, Snapshot };
  hooks = await import("../src/node-compat/async_hooks.js"); // picks its backend at load
});
afterAll(() => {
  delete g.AsyncContext;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("node:async_hooks over native AsyncContext", () => {
  it("installs nothing: Promise.prototype.then stays the engine's", () => {
    hooks.installAsyncContext();
    expect(Promise.prototype.then).toBe(thenBefore);
  });

  it("concurrent runs keep their own stores across native awaits", async () => {
    const als = new hooks.AsyncLocalStorage<string>();
    async function* ticks() {
      yield 1;
      await sleep(1);
      yield 2;
    }
    const probe = (name: string) =>
      als.run(name, async () => {
        const seen = [als.getStore()];
        await null;
        seen.push(als.getStore());
        await sleep(Math.random() * 5);
        seen.push(als.getStore());
        for await (const _ of ticks()) seen.push(als.getStore());
        seen.push(await als.run(`${name}/inner`, async () => (await sleep(1), als.getStore())));
        seen.push(als.exit(() => als.getStore()) ?? "none");
        seen.push(
          await new Promise<string | undefined>((r) => setTimeout(() => r(als.getStore()))),
        );
        return seen;
      });
    const names = ["a", "b", "c", "d"];
    expect(await Promise.all(names.map(probe))).toEqual(
      names.map((n) => [n, n, n, n, n, `${n}/inner`, "none", n]),
    );
    expect(als.getStore()).toBeUndefined();
  });

  it("snapshot, bind, disable; enterWith is refused", async () => {
    const als = new hooks.AsyncLocalStorage<string>();
    const [later, bound] = als.run("x", () => [
      hooks.AsyncLocalStorage.snapshot(),
      hooks.AsyncLocalStorage.bind(() => als.getStore()),
    ]);
    expect(later(() => als.getStore())).toBe("x");
    expect(bound()).toBe("x");
    als.run("y", () => {
      als.disable();
      expect(als.getStore()).toBeUndefined();
    });
    expect(als.run("z", () => als.getStore())).toBe("z"); // run() lifts disable()
    expect(() => als.enterWith("w")).toThrow(/not available with AsyncContext/);
  });

  it("lowered code runs on it too", async () => {
    const { lowerAwait } = await import("../src/project/lower-await.js");
    const als = new hooks.AsyncLocalStorage<string>();
    const code = lowerAwait(
      "async function probe(n) { return als.run(n, async () => { await sleep(Math.random() * 5); return als.getStore(); }); }",
    );
    const probe = new Function("als", "sleep", `${code}\nreturn probe;`)(als, sleep);
    expect(await Promise.all(["a", "b"].map(probe))).toEqual(["a", "b"]);
  });

  it("asyncRoot starts events in the AsyncContext snapshot it was made in", async () => {
    const { asyncRoot } = await import("../src/core/async-context.js");
    const als = new hooks.AsyncLocalStorage<string>();
    // Take the browser path: no process.getBuiltinModule there.
    const spy = vi.spyOn(process, "getBuiltinModule").mockReturnValue(undefined as never);
    try {
      const root = asyncRoot();
      const scoped = als.run("runtime", () => asyncRoot());
      expect(als.run("caller", () => root(() => als.getStore()))).toBeUndefined();
      expect(als.run("caller", () => scoped(() => als.getStore()))).toBe("runtime");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("lowering follows the realm", () => {
  // webrun-site-builder routes with URLPattern: Node 24 and browsers have it, Node 22 does not.
  it.skipIf(typeof (globalThis as { URLPattern?: unknown }).URLPattern === "undefined")(
    "a site lowers nothing when the browser has AsyncContext, unless asked to",
    async () => {
      const { createProjectSite } = await import("../src/project/site.js");
      const projectFiles = new MemFilesApi();
      const src = "export default { async fetch() { await null; return new Response('ok'); } };";
      await projectFiles.write("/index.js", [new TextEncoder().encode(src)]);
      const served = async (lowerAwait?: boolean) => {
        const site = createProjectSite({ projectFiles, nodeCompat: true, lowerAwait });
        const res = await site(new Request("http://site.test/modules/~/index.js"));
        return res.text();
      };
      expect(await served()).toMatch(/await null/);
      expect(await served(true)).not.toMatch(/\bawait\b/);
    },
  );

  it("bundleWorkerForBrowser lowers by default with nodejs_compat; lowerAwait: false keeps await", async () => {
    const { bundleWorkerForBrowser } = await import("../src/project/browser-bundle.js");
    const dir = mkdtempSync(join(tmpdir(), "cellb-lower-"));
    writeFileSync(
      join(dir, "index.js"),
      "export default { async fetch() { await null; return new Response('ok'); } };",
    );
    const entry = join(dir, "index.js");
    expect(await bundleWorkerForBrowser(entry, { nodeCompat: true })).not.toMatch(/\bawait\b/);
    expect(await bundleWorkerForBrowser(entry, { nodeCompat: true, lowerAwait: false })).toMatch(
      /await null/,
    );
  });
});
