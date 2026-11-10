// Non-JS imports as wrangler bundles them: `.wasm` as workerd's CompiledWasm rule (default export a
// WebAssembly.Module), and the project's `rules` of type Text and Data, on Node and in a build.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildProject, loadProject } from "@statewalker/cellb/node";
import { afterEach, describe, expect, test } from "vitest";
import { effectiveRules, globFilter } from "../src/project/module-rules.js";

const FIXTURE = resolve(import.meta.dirname, "fixtures/wasm-modules");
const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const p of opened.splice(0)) await p.close();
});

async function answer(source: string) {
  const project = await loadProject(source);
  opened.push(project);
  const res = await project.fetch(new Request("http://localhost/?a=2&b=40"));
  expect(res.status).toBe(200);
  return res.json();
}

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

  test("a project rule of a type replaces its defaults unless it falls through", () => {
    const types = (r: ReturnType<typeof effectiveRules>) => r.map((x) => `${x.type}:${x.globs}`);
    expect(types(effectiveRules([{ type: "Text", globs: ["**/*.md"] }]))).toEqual([
      "Text:**/*.md",
      "Data:**/*.bin",
      "CompiledWasm:**/*.wasm,**/*.wasm?module",
    ]);
    expect(
      effectiveRules([{ type: "Text", globs: ["**/*.md"], fallthrough: true }]).map((r) => r.type),
    ).toEqual(["Text", "Text", "Data", "CompiledWasm"]);
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
    expect(await answer(out)).toEqual(EXPECTED);
  });
});
