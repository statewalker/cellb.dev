// Non-JS imports as wrangler bundles them: `.wasm` as workerd's CompiledWasm rule (default export a
// WebAssembly.Module), and the project's `rules` of type Text and Data, on Node and in a build.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildProject, loadProject } from "@statewalker/cellb/node";
import { afterEach, describe, expect, test } from "vitest";
import { effectiveRules, globFilter, type ModuleRule } from "../src/project/module-rules.js";

const FIXTURE = resolve(import.meta.dirname, "fixtures/wasm-modules");
const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const p of opened.splice(0)) await p.close();
});

async function answer(source: string, path = "/?a=2&b=40") {
  const project = await loadProject(source);
  opened.push(project);
  const res = await project.fetch(new Request(`http://localhost${path}`));
  expect(res.status).toBe(200);
  return res.json();
}

/** A project in a fresh folder: path → contents (`wrangler.jsonc` from `config`). */
function project(files: Record<string, string | Uint8Array>, config: object = {}, dir?: string) {
  dir ??= mkdtempSync(join(tmpdir(), "cellb-rules-"));
  const all = {
    "wrangler.jsonc": JSON.stringify({ name: "rules", main: "index.js", ...config }),
    ...files,
  };
  for (const [path, contents] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return dir;
}

const ADD_WASM = readFileSync(join(FIXTURE, "add.wasm"));

/** LEB128 of an unsigned integer. */
const leb = (n: number) => {
  const out: number[] = [];
  do {
    const byte = n & 0x7f;
    n >>>= 7;
    out.push(n ? byte | 0x80 : byte);
  } while (n);
  return out;
};
const section = (id: number, body: number[] | Uint8Array) => [id, ...leb(body.length), ...body];

/** `add(i32,i32)` plus a memory filled by a data segment of `size` bytes. */
function bigWasm(size: number): Uint8Array {
  const data = new Uint8Array(size).map((_, i) => (i * 31) & 0xff);
  const pages = Math.ceil(size / 65536);
  const head = [
    ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    ...section(1, [0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f]),
    ...section(3, [0x01, 0x00]),
    ...section(5, [0x01, 0x00, ...leb(pages)]),
    ...section(7, [0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00]),
    ...section(10, [0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b]),
  ];
  const segment = [0x01, 0x00, 0x41, 0x00, 0x0b, ...leb(size)];
  const dataSection = [11, ...leb(segment.length + size), ...segment];
  const out = new Uint8Array(head.length + dataSection.length + size);
  out.set(head);
  out.set(dataSection, head.length);
  out.set(data, head.length + dataSection.length);
  return out;
}

const SUM_WORKER = (spec: string) => `import add from ${JSON.stringify(spec)};
export default {
  fetch() {
    return Response.json({ sum: new WebAssembly.Instance(add).exports.add(2, 40) });
  },
};`;

const EXPECTED = {
  sum: 42,
  module: true,
  sameModuleRule: 42,
  greeting: "hello from a Text rule\n",
  data: [1, 2, 3, 255],
};

describe("module rules", () => {
  test("globs match import specifiers as wrangler's", () => {
    const wasm = globFilter("**/*.wasm");
    expect(wasm.test("./add.wasm")).toBe(true);
    expect(wasm.test("../lib/add.wasm")).toBe(true);
    expect(wasm.test("pkg/dist/add.wasm")).toBe(true);
    expect(wasm.test("./add.wasm.js")).toBe(false);
    expect(globFilter("**/*.wasm?module").test("./add.wasm?module")).toBe(true);
    expect(globFilter("**/*.wasm?module").test("./addXwasmYmodule")).toBe(false);
    expect(globFilter("src/*.bin").test("src/a.bin")).toBe(true);
    expect(globFilter("src/*.bin").test("src/x/a.bin")).toBe(false);
  });

  test("a trailing or bare ** spans any depth", () => {
    expect(globFilter("assets/**").test("assets/a/b/c.txt")).toBe(true);
    expect(globFilter("assets/**").test("other/a.txt")).toBe(false);
    expect(globFilter("**").test("./x/y.bin")).toBe(true);
  });

  test("rules are parsed as wrangler's parseRules: the first closing rule of a type wins", () => {
    const globs = (r: ModuleRule[]) => r.map((x) => `${x.type}:${x.globs}`);
    // a closing Text rule turns the default Text globs (.txt, .html, .sql) off
    const closed = effectiveRules([{ type: "Text", globs: ["**/*.md"] }]);
    expect(globs(closed.rules)).toEqual([
      "Text:**/*.md",
      "Data:**/*.bin",
      "CompiledWasm:**/*.wasm,**/*.wasm?module",
    ]);
    expect(closed.rules.some((r) => r.globs.includes("**/*.html"))).toBe(false);
    expect(closed.ignored).toEqual([]);
    // fallthrough: true keeps the later rules of the type, the defaults among them
    const through = effectiveRules([
      { type: "Text", globs: ["**/*.md"], fallthrough: true },
      { type: "Text", globs: ["**/*.csv"] },
    ]);
    expect(globs(through.rules)).toEqual([
      "Text:**/*.md",
      "Text:**/*.csv",
      "Data:**/*.bin",
      "CompiledWasm:**/*.wasm,**/*.wasm?module",
    ]);
    // a later project rule of a closed type is dropped, with a warning
    const dropped = effectiveRules([
      { type: "Data", globs: ["**/*.dat"] },
      { type: "Data", globs: ["**/*.raw"] },
    ]);
    expect(globs(dropped.rules).filter((g) => g.startsWith("Data"))).toEqual(["Data:**/*.dat"]);
    expect(dropped.ignored).toEqual([
      "rules[1] (Data) is ignored: rules[0] has the same type and no `fallthrough = true`",
    ]);
    // fallthrough: false closes the type quietly
    expect(
      effectiveRules([
        { type: "Data", globs: ["**/*.dat"], fallthrough: false },
        { type: "Data", globs: ["**/*.raw"] },
      ]).ignored,
    ).toEqual([]);
  });

  test("Node: .wasm imports a WebAssembly.Module; Text and Data rules apply", async () => {
    expect(await answer(FIXTURE)).toEqual(EXPECTED);
  });

  test("cellb build inlines the files: no import left, and the folder runs", async () => {
    const out = mkdtempSync(join(tmpdir(), "cellb-build-wasm-"));
    await buildProject(FIXTURE, out);
    const code = readFileSync(join(out, "worker.js"), "utf8");
    expect(code).not.toMatch(/\.(wasm|md|dat)\b["'?]/);
    expect(code).toContain("new WebAssembly.Module(");
    expect(code).not.toContain("await WebAssembly.compile(");
    expect(await answer(out)).toEqual(EXPECTED);
  });
  test("cellb build with nodejs_compat (awaits lowered) runs the wasm import", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cellb-rules-compat-"));
    for (const name of ["add.wasm", "bytes.dat", "greeting.md", "index.js"])
      writeFileSync(join(dir, name), readFileSync(join(FIXTURE, name)));
    project(
      {},
      {
        compatibility_date: "2025-04-01",
        compatibility_flags: ["nodejs_compat"],
        rules: [
          { type: "Text", globs: ["**/*.md"] },
          { type: "Data", globs: ["**/*.dat"] },
        ],
      },
      dir,
    );
    const out = mkdtempSync(join(tmpdir(), "cellb-build-compat-"));
    await buildProject(dir, out);
    expect(await answer(out)).toEqual(EXPECTED);
  });

  test("a wasm import inside circular imports loads (compiled synchronously, as workerd does)", async () => {
    // a.js and b.js import each other, b.js imports a .wasm, and index.js also imports b.js
    // dynamically, so esbuild wraps the modules in lazy inits. With a top-level await in the wasm
    // module those inits were async, b's waited on a's and a's on b's, and loadProject never
    // settled.
    const dir = project({
      "add.wasm": ADD_WASM,
      "a.js": `import { viaB } from "./b.js";
export const name = "a";
export const fromA = (x, y) => viaB(x, y);`,
      "b.js": `import wasm from "./add.wasm";
import { name } from "./a.js";
const { add } = new WebAssembly.Instance(wasm).exports;
export const viaB = (x, y) => ({ from: name, sum: add(x, y) });`,
      "index.js": `import { fromA } from "./a.js";
export default {
  fetch: async () => Response.json({ ...fromA(2, 40), again: (await import("./b.js")).viaB(1, 1).sum }),
};`,
    });
    const settled = await Promise.race([
      answer(dir, "/"),
      new Promise((r) => setTimeout(() => r("loadProject did not settle"), 3_000)),
    ]);
    expect(settled).toEqual({ from: "a", sum: 42, again: 2 });
  });

  test("one file reached by rules of two types is two modules", async () => {
    const root = mkdtempSync(join(tmpdir(), "cellb-rules-id-"));
    const dir = project(
      {
        "sub/a.txt": "text",
        "index.js": `import a from "./sub/a.txt";
import b from "../proj/sub/a.txt";
export default { fetch: () => Response.json({ a, b: b instanceof ArrayBuffer ? b.byteLength : b }) };`,
      },
      { rules: [{ type: "Data", globs: ["../**/*.txt"] }] },
      join(root, "proj"),
    );
    expect(await answer(dir, "/")).toEqual({ a: "text", b: 4 });
  });

  test("a Text module keeps a UTF-8 BOM", async () => {
    const dir = project({
      "bom.txt": new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]),
      "index.js": `import t from "./bom.txt";
export default { fetch: () => Response.json({ codes: [...t].map((c) => c.charCodeAt(0)) }) };`,
    });
    expect(await answer(dir, "/")).toEqual({ codes: [0xfeff, 0x68, 0x69] });
  });

  test("a package's .wasm through its exports", async () => {
    const dir = project({
      "node_modules/adder/package.json": JSON.stringify({
        name: "adder",
        exports: { "./add.wasm": "./dist/add.wasm" },
      }),
      "node_modules/adder/dist/add.wasm": ADD_WASM,
      "index.js": SUM_WORKER("adder/add.wasm"),
    });
    expect(await answer(dir, "/")).toEqual({ sum: 42 });
  });

  test("a missing file is refused naming the import and its importer", async () => {
    const dir = project({ "index.js": SUM_WORKER("./missing.wasm?module") });
    const err = await loadProject(dir).then(
      (p) => {
        opened.push(p);
        return null;
      },
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/index\.js/);
    expect(err?.message).toMatch(/missing\.wasm/);
    expect(err?.message).not.toMatch(/ENOENT/);
  });

  test("an unsupported rule type is reported", async () => {
    const dir = project(
      { "index.js": SUM_WORKER("./add.wasm"), "add.wasm": ADD_WASM },
      {
        rules: [
          { type: "PythonModule", globs: ["**/*.py"] },
          { type: "ESModule", globs: ["**/*.mjs"] },
        ],
      },
    );
    const p = await loadProject(dir);
    opened.push(p);
    expect(p.unsupported).toEqual(['rules[0].type "PythonModule"']);
  });

  test("a 2 MB wasm loads on Node in reasonable time", async () => {
    const dir = project({
      "big.wasm": bigWasm(2 * 1024 * 1024),
      "index.js": SUM_WORKER("./big.wasm"),
    });
    const start = performance.now();
    expect(await answer(dir, "/")).toEqual({ sum: 42 });
    expect(performance.now() - start).toBeLessThan(10_000);
  });
});
