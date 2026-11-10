import { describe, expect, it } from "vitest";
import { browserModuleLoader } from "../src/project/browser-modules.js";

// The browser Worker Loader makes one Blob URL per module, and a Blob URL needs its text (with
// its imports' URLs) first: modules that import each other are refused with a clear error
// instead of recursing until the stack overflows.
describe("browserModuleLoader", () => {
  it("refuses modules that import each other, naming the cycle", async () => {
    const load = browserModuleLoader();
    await expect(
      load("cycle", {
        compatibilityDate: "2026-01-01",
        mainModule: "a.js",
        modules: {
          "a.js": 'import { b } from "./b.js"; export default {};',
          "b.js": 'import { c } from "./c.js"; export const b = 1;',
          "c.js": 'import a from "./a.js"; export const c = 2;',
        },
      } as never),
    ).rejects.toThrow(/a\.js → b\.js → c\.js → a\.js/);
  });
});
