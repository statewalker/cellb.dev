import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { createProjectRuntime } from "../src/index.js";
import { loadNodeProject, nodeSqliteOpener } from "../src/node.js";
import { hasNodeCompat, populatesProcessEnv } from "../src/project/wrangler.js";

// The two process.env flags are honoured by every host (populatesProcessEnv), so they are not
// reported as unsupported.

const FLAGS = [
  ["nodejs_compat_populate_process_env", true],
  ["nodejs_compat_do_not_populate_process_env", false],
] as const;

describe("P45 process.env compatibility flags", () => {
  it("turns nodejs_compat on only for nodejs_compat and nodejs_compat_v2, as workerd does", () => {
    expect(hasNodeCompat({ compatibility_flags: ["nodejs_compat"] })).toBe(true);
    expect(hasNodeCompat({ compatibility_flags: ["nodejs_compat_v2"] })).toBe(true);
    // The process.env flags tune nodejs_compat; alone they enable nothing.
    for (const [flag] of FLAGS) {
      const config = { compatibility_date: "2026-01-01", compatibility_flags: [flag] };
      expect(hasNodeCompat(config)).toBe(false);
      expect(populatesProcessEnv(config)).toBe(false);
    }
  });

  it.each(FLAGS)("does not report %s as unsupported", async (flag) => {
    const p = createProjectRuntime(
      { compatibility_flags: ["nodejs_compat", flag] },
      { default: {} },
      { openSql: nodeSqliteOpener(), files: new MemFilesApi() },
    );
    expect(p.unsupported).toEqual([]);
    await p.runtime.close();
  });

  it("still reports a flag cellb does not know", async () => {
    const p = createProjectRuntime(
      { compatibility_flags: ["no_such_flag"] },
      { default: {} },
      { openSql: nodeSqliteOpener(), files: new MemFilesApi() },
    );
    expect(p.unsupported).toEqual(["compatibility_flags: no_such_flag"]);
    await p.runtime.close();
  });

  it.each(FLAGS)("%s decides whether process.env holds the vars", async (flag, filled) => {
    // A date on the other side of 2025-04-01 from the flag, so that the flag decides.
    const date = filled ? "2024-09-23" : "2025-06-01";
    const config = { compatibility_date: date, compatibility_flags: ["nodejs_compat", flag] };
    expect(populatesProcessEnv(config)).toBe(filled);

    const key = `P45_${filled ? "FILLED" : "EMPTY"}`;
    const dir = mkdtempSync(join(tmpdir(), "p45-"));
    writeFileSync(
      join(dir, "index.js"),
      `export default { fetch() { return Response.json({ v: process.env.${key} ?? null }); } };`,
    );
    writeFileSync(
      join(dir, "wrangler.json"),
      JSON.stringify({ name: "p45", main: "index.js", vars: { [key]: "yes" }, ...config }),
    );
    const p = await loadNodeProject(dir, { openSql: nodeSqliteOpener(), files: new MemFilesApi() });
    try {
      expect(p.unsupported).toEqual([]);
      const res = await p.runtime.fetch(new Request("http://w/"));
      expect(await res.json()).toEqual({ v: filled ? "yes" : null });
    } finally {
      await p.runtime.close();
      delete process.env[key];
    }
  });
});
