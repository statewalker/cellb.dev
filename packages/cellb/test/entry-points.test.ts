// The supported interface: the package's entry points, imported by the package's own name.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCellRuntime, DurableObject } from "@statewalker/cellb";
import { nodeSqliteOpener } from "@statewalker/cellb/node";
import { expect, test } from "vitest";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// What runs when a module is imported: static imports and re-exports, not `import type`/`import()`.
const STATIC = /^\s*(?:import|export)\s+(?!type\b)(?:[^;"']*?\bfrom\s*)?["']([^"']+)["']/gm;

/** Every non-relative specifier `entry` loads at import time, with the file that imports it. */
function staticImports(entry: string): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(STATIC)) {
      if (!spec.startsWith(".")) {
        out.push([spec, relative(PKG, file)]);
        continue;
      }
      const ts = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      visit(existsSync(ts) ? ts : resolve(dirname(file), spec));
    }
  };
  visit(resolve(PKG, entry));
  return out;
}

test.each(["src/index.ts", "src/browser.ts", "src/isolate/isolate-worker.ts"])(
  "importing %s loads no node: builtin",
  (entry) => {
    expect(staticImports(entry).filter(([spec]) => spec.startsWith("node:"))).toEqual([]);
  },
);

// The in-browser site compiler (webrun-modules, and through it lightningcss-wasm and @jspm/core)
// is an optional peer dependency, reached only through @statewalker/cellb/site: importing any
// other entry point must not load it, or bundlers emit its 16 MB .wasm with every app.
// The in-browser bundler (webrun-bundler, which loads webrun-modules) is reached only through
// @statewalker/cellb/bundle, the same way (#72): `loadProject` takes a compiler, it never imports one.
const SITE_COMPILER = [
  "@statewalker/webrun-bundler",
  "esbuild-wasm",
  "@statewalker/webrun-modules",
  "@statewalker/webrun-site-builder",
  "@statewalker/webrun-site-host",
  "lightningcss-wasm",
];
// What a bundler emits for `entry`: static imports and dynamic `import("…")`, which becomes a
// chunk of its own (its .wasm included), followed through relative modules.
const DYNAMIC = /\bimport\s*\(\s*["']([^"']+)["']/g;
function bundledImports(entry: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const re of [STATIC, DYNAMIC])
      for (const [, spec] of text.matchAll(re)) {
        if (!spec.startsWith(".")) {
          out.push(spec);
          continue;
        }
        const ts = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
        const target = existsSync(ts) ? ts : resolve(dirname(file), spec);
        if (existsSync(target)) visit(target);
      }
  };
  visit(resolve(PKG, entry));
  return out;
}
test.each([
  "src/index.ts",
  "src/browser.ts",
  "src/node.ts",
  "src/project/host-modules.ts",
  "src/isolate/isolate-worker.ts",
])("importing %s loads none of the in-browser site compiler", (entry) => {
  expect(bundledImports(entry).filter((spec) => SITE_COMPILER.includes(spec))).toEqual([]);
});

test("@statewalker/cellb/site is where the site compiler is reached", () => {
  expect(staticImports("src/site.ts").map(([spec]) => spec)).toContain(
    "@statewalker/webrun-modules",
  );
});

test("@statewalker/cellb/bundle is where the bundler is reached", () => {
  expect(staticImports("src/bundle.ts").map(([spec]) => spec)).toContain(
    "@statewalker/webrun-bundler",
  );
  // A bundle compiler loads no site compiler of its own (webrun-bundler brings what it needs).
  expect(staticImports("src/bundle.ts").map(([spec]) => spec)).not.toContain(
    "@statewalker/webrun-site-host",
  );
});

class Counter extends DurableObject {
  increment(): number {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS c (id INTEGER PRIMARY KEY, n INTEGER)");
    sql.exec("INSERT INTO c (id, n) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1");
    return sql.exec<{ n: number }>("SELECT n FROM c WHERE id = 1").one().n;
  }
}

test("a counter Durable Object runs through @statewalker/cellb and @statewalker/cellb/node", async () => {
  const worker = {
    Counter,
    default: {
      fetch: async (req: Request, env: any) =>
        Response.json({ n: await env.COUNTER.getByName(new URL(req.url).pathname).increment() }),
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "entry-points-"));
  const rt = createCellRuntime({
    worker,
    durableObjects: { COUNTER: { className: "Counter" } },
    openSql: nodeSqliteOpener(dir),
  });
  expect(await (await rt.fetch(new Request("http://local/counter/a"))).json()).toEqual({ n: 1 });
  expect(await (await rt.fetch(new Request("http://local/counter/a"))).json()).toEqual({ n: 2 });
  await rt.close();
});
