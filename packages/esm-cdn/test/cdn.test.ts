import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/cdn.js";

describe("parseSpec", () => {
  it("splits names, ranges and subpaths, scope-aware", () => {
    expect(parseSpec("react")).toEqual({ pkg: "react", version: undefined, subpath: undefined });
    expect(parseSpec("react-dom@19/client")).toEqual({
      pkg: "react-dom",
      version: "19",
      subpath: "client",
    });
    expect(parseSpec("@observablehq/plot@0.6")).toEqual({
      pkg: "@observablehq/plot",
      version: "0.6",
      subpath: undefined,
    });
    expect(parseSpec("@scope/pkg@1.2.3/dist/x.js")).toEqual({
      pkg: "@scope/pkg",
      version: "1.2.3",
      subpath: "dist/x.js",
    });
  });

  it("keeps an encoded / or @ inside the range", () => {
    expect(parseSpec("x@github%3Au%2Fr")?.version).toBe("github:u/r");
    expect(parseSpec("x@npm%3Ay%401")?.version).toBe("npm:y@1");
  });

  it("refuses malformed specs", () => {
    for (const bad of ["@scope", "%E0%A4%A", "../etc", "react/../x", "@/x", ""])
      expect(parseSpec(bad)).toBeUndefined();
  });
});
