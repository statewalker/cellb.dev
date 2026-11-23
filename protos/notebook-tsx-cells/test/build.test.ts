// PROTOTYPE (statewalker/statewalker-root#236): the build seam.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPage } from "../src/build.ts";

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
});
