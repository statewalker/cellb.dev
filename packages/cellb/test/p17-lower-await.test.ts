import { describe, expect, it } from "vitest";
import { AsyncLocalStorage, installAsyncContext } from "../src/node-compat/async_hooks.js";
import { lowerAwait } from "../src/project/lower-await.js";

// An in-browser site's modules are compiled by webrun-modules; cellb lowers their awaits to
// generators so that cellb's node:async_hooks polyfill can carry AsyncLocalStorage stores
// through them, as bundleWorkerForBrowser does with esbuild.

/** Runs lowered `code` (a function body that returns a promise) with `scope` in reach. */
function run(code: string, scope: Record<string, unknown> = {}): Promise<unknown> {
  const lowered = lowerAwait(`async function __main() {\n${code}\n}`);
  const names = Object.keys(scope);
  return new Function(...names, `${lowered}\nreturn __main();`)(...Object.values(scope));
}

describe("lowerAwait", () => {
  it("leaves code without async functions as it is", () => {
    const code = "const a = 1; function f() { return a; } // async is only a word here";
    expect(lowerAwait(code)).toBe(code);
    expect(lowerAwait("export const x = (")).toBe("export const x = ("); // does not parse
  });

  it("removes every await from lowered functions", () => {
    const out = lowerAwait(
      "export default { async fetch(r) { return await r; } };\n" +
        "class A { static async [k]() { await 1; } async m() { for await (const x of y) await x; } }\n" +
        "const f = async (x) => await x, g = async x => ({ x: await x });\n" +
        "export async function h() { const o = { a, async b() { await a; } }; return o; }",
    );
    expect(out).not.toMatch(/\bawait\b/);
    expect(out.match(/\basync\b/g)).toBeNull();
  });

  it("keeps the meaning: values, errors, this, arguments, order", async () => {
    expect(
      await run(`
        const log = [];
        const obj = {
          n: 2,
          async twice(a) { await null; return this.n * a * arguments.length; },
        };
        async function fails() { await null; throw new Error("boom"); }
        const arrow = async (x) => (await x) + 1;
        const exprObj = async () => ({ k: await 1 });
        let caught;
        try { await fails(); } catch (e) { caught = e.message; }
        const p = (async () => { log.push("a"); await null; log.push("c"); })();
        log.push("b");
        await p;
        return [await obj.twice(5), caught, await arrow(Promise.resolve(1)), await exprObj(), log];
      `),
    ).toEqual([10, "boom", 2, { k: 1 }, ["a", "b", "c"]]);
  });

  it("lowers for await: async and sync iterables, break, labels, closing the iterator", async () => {
    expect(
      await run(`
        const seen = [];
        let closed = false;
        async function* gen() { try { yield 1; await null; yield 2; yield 3; } finally { closed = true; } }
        for await (const x of gen()) { if (x === 2) break; seen.push(x); }
        for await (const x of [Promise.resolve("p"), "q"]) seen.push(x);
        let y;
        outer: for await (y of gen()) { for (const z of [1, 2]) { if (z === 2) continue outer; seen.push(y * 10 + z); } }
        for await (const [a, { b }] of [[1, { b: 2 }]]) seen.push(a + b);
        return [seen, closed, y];
      `),
    ).toEqual([[1, "p", "q", 11, 21, 31, 3], true, 3]);
  });

  it("leaves async functions that use super, and async generators, as they are", () => {
    const code =
      "class B extends A { async m() { await super.m(); } }\nasync function* g() { await 1; yield 2; }";
    expect(lowerAwait(code)).toBe(code);
  });

  it("with the polyfill's continuations, concurrent runs keep their own stores", async () => {
    installAsyncContext();
    const als = new AsyncLocalStorage<string>();
    const results = await run(
      `
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        async function* ticks() { yield 1; await sleep(1); yield 2; }
        async function probe(name) {
          return als.run(name, async () => {
            const seen = [];
            await null;
            seen.push(als.getStore());
            await sleep(Math.random() * 5);
            seen.push(als.getStore());
            for await (const _ of ticks()) seen.push(als.getStore());
            seen.push(await (async () => { await sleep(1); return als.getStore(); })());
            return seen;
          });
        }
        return Promise.all(["a", "b", "c", "d"].map(probe));
      `,
      { als },
    );
    expect(results).toEqual(["a", "b", "c", "d"].map((n) => [n, n, n, n, n]));
    expect(als.getStore()).toBeUndefined();
  });
});
