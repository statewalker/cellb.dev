// Guard: no import cycle anywhere in src/ (type-only imports included).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

function edges(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(SPEC)].map((m) => resolve(dirname(file), m[1].replace(/\.js$/, ".ts")));
}

test("src/ has no import cycles", () => {
  const graph = new Map(files(SRC).map((f) => [f, edges(f)]));
  const cycles: string[] = [];
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const visit = (f: string) => {
    state.set(f, "open");
    stack.push(f);
    for (const g of graph.get(f) ?? []) {
      if (!graph.has(g)) continue;
      if (state.get(g) === "open") {
        cycles.push(
          stack
            .slice(stack.indexOf(g))
            .concat(g)
            .map((p) => relative(SRC, p))
            .join(" -> "),
        );
      } else if (!state.has(g)) visit(g);
    }
    stack.pop();
    state.set(f, "done");
  };
  for (const f of graph.keys()) if (!state.has(f)) visit(f);
  expect(cycles).toEqual([]);
});
