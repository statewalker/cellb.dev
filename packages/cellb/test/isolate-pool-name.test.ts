// statewalker/cellb.dev#251: isolates' pools are named so a fragment's removal deletes its own,
// never another fragment's, and pools of the former name are still opened.
import { describe, expect, it } from "vitest";
import { isIsolatePoolOf, isolatePoolName } from "../src/isolate/pool-name.js";

describe("isIsolatePoolOf", () => {
  // Fragment `a` in shard 0, and fragments whose ids are chosen to collide with its names.
  const pool = "fragments-a-shard-0";
  it.each([
    [".fragments-a-shard-0-ISO-x", true],
    [".fragments-a-shard-0-ISO-loader.v1", true],
    [".fragments-a-shard-0-iso-x", true], // a pool of the former name, still a's
    // fragment `a-shard-0-iso-x`'s pool and its isolates', old and new names
    [".fragments-a-shard-0-iso-x-shard-0", false],
    [".fragments-a-shard-0-iso-x-shard-0-iso-y", false],
    [".fragments-a-shard-0-iso-x-shard-0-ISO-y", false],
    // fragment `a`'s own pool and files directory are not isolates'
    [".fragments-a-shard-0", false],
    ["fragments-a-files-0", false],
    // another shard of `a`
    [".fragments-a-shard-1-ISO-x", false],
  ])("%s → %s", (entry, mine) => {
    expect(isIsolatePoolOf(pool, entry)).toBe(mine);
  });
});

describe("isolatePoolName", () => {
  const has =
    (...names: string[]) =>
    async (n: string) =>
      names.includes(n);
  const load = { storageName: "p-ISO-x", legacyStorageName: "p-iso-x" };

  it("opens the current name for a new isolate", async () => {
    expect(await isolatePoolName(load, has())).toBe("p-ISO-x");
  });
  it("opens a pool of the former name where only that one exists", async () => {
    expect(await isolatePoolName(load, has("p-iso-x"))).toBe("p-iso-x");
  });
  it("prefers the current name once it exists", async () => {
    expect(await isolatePoolName(load, has("p-iso-x", "p-ISO-x"))).toBe("p-ISO-x");
  });
  it("names an isolate without a prefix as before", async () => {
    expect(await isolatePoolName(undefined, has())).toBe("isolate");
  });
});
