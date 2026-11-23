// PROTOTYPE (statewalker/statewalker-root#236): the build seam.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPage } from "../src/build.ts";
import type { TypeChecker } from "../src/checkers.ts";
import { noTypeCheck, pageOrderChecker } from "../src/checkers.ts";

const fixture = (name: string) => join(import.meta.dirname, "fixtures", name);
const out = () => mkdtempSync(join(tmpdir(), "nb-proto-"));

describe("building a notebook page", () => {
  it("fails on a type error in a ts cell and names its line in the Markdown file", async () => {
    const result = await buildPage(fixture("ts-error.md"), out());
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ file: fixture("ts-error.md"), line: 6 });
    expect(result.errors[0].message).toMatch(/not assignable to type 'number'/);
  });

  it("fails when a tsx cell imports an export the real package does not have", async () => {
    const result = await buildPage(fixture("removed-api.md"), out());
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({ file: fixture("removed-api.md"), line: 4 });
    expect(result.errors[0].message).toMatch(/has no exported member named 'startProcesses'/);
  });

  it("builds the demo page with ts, jsx and tsx cells into an HTML page", async () => {
    const dir = out();
    const result = await buildPage(join(import.meta.dirname, "..", "page", "index.md"), dir);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, "index.html"))).toBe(true);
  });

  it("checks JSX against a shadcn component's prop types, across cells", async () => {
    const result = await buildPage(fixture("jsx-prop-error.md"), out());
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({ file: fixture("jsx-prop-error.md"), line: 10 });
    expect(result.errors[0].message).toMatch(/"bogus"/);
  });

  it("accepts a cell that uses a name another cell defines further down the page", async () => {
    const result = await buildPage(fixture("later-definition.md"), out());
    expect(result.errors).toEqual([]);
  });

  it("types a Mutable as its value in the cells that read it", async () => {
    const result = await buildPage(fixture("mutable-value.md"), out());
    expect(result.errors).toEqual([]);
  });

  it("reports an error at its own Markdown line after cells are put in dependency order", async () => {
    const result = await buildPage(fixture("reordered-error.md"), out());
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ file: fixture("reordered-error.md"), line: 4, cell: 1 });
    expect(result.errors[0].message).toMatch(/toUpperCase/);
  });

  it("takes the type checker as a plug-in: none, or a custom one", async () => {
    expect((await buildPage(fixture("ts-error.md"), out(), { checker: noTypeCheck })).ok).toBe(true);
    const custom: TypeChecker = { name: "custom", check: ({ path, cells }) => [{ file: path, line: cells[0].line, column: 1, message: "custom" }] };
    const result = await buildPage(fixture("later-definition.md"), out(), { checker: custom });
    expect(result.errors).toEqual([{ file: fixture("later-definition.md"), line: 4, column: 1, message: "custom" }]);
  });

  it("the page-order checker, blind to reactivity, rejects what the reactive checker accepts", async () => {
    const later = await buildPage(fixture("later-definition.md"), out(), { checker: pageOrderChecker });
    expect(later.errors[0].message).toMatch(/used before its declaration/);
    const mutable = await buildPage(fixture("mutable-value.md"), out(), { checker: pageOrderChecker });
    expect(mutable.errors[0]).toMatchObject({ line: 9 });
  });
});
