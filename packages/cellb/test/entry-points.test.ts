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

test("importing the isomorphic entry point loads no node: builtin", () => {
  expect(staticImports("src/index.ts").filter(([spec]) => spec.startsWith("node:"))).toEqual([]);
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
