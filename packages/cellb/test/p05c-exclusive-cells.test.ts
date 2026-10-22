import { fork } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// Hypothesis: on one host, opening cell databases in SQLite EXCLUSIVE locking mode
// fences storage itself — a second process cannot touch a cell another process serves,
// and the OS frees it when the owner dies. (Probe: probes/sqlite-lock.probe.mjs.)
describe("P05c storage-level fencing: cell SQLite files in EXCLUSIVE locking mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "cells-excl-"));
  let bundle = "";
  beforeAll(async () => {
    bundle = join(dir, "cell-open.mjs");
    await build({
      entryPoints: [join(__dirname, "cell-open.entry.ts")],
      outfile: bundle,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
      banner: {
        js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      },
    });
  });
  // Every child is killed after the test, also when an assertion fails first: a "hold"
  // owner left alive kept vitest from exiting (seen under the mutation harness).
  const children = new Set<ReturnType<typeof fork>>();
  afterEach(() => {
    for (const c of children) c.kill("SIGKILL");
    children.clear();
  });
  const run = (name: string, mode: "hold" | "once") => {
    const p = fork(bundle, [dir, name, mode], { execArgv: ["--no-warnings"] });
    children.add(p);
    return { p, msg: new Promise<any>((r) => p.once("message", r)) };
  };

  it("a second process cannot serve (or read) a cell held by a live owner; kill -9 frees it", async () => {
    const owner = run("x", "hold");
    expect(await owner.msg).toEqual({ type: "ok", n: 1 });
    const intruder = await run("x", "once").msg;
    expect(intruder.type).toBe("error");
    expect(intruder.message).toMatch(/locked/);
    owner.p.kill("SIGKILL");
    await new Promise((r) => owner.p.once("exit", r));
    expect(await run("x", "once").msg).toEqual({ type: "ok", n: 2 }); // state kept, lock gone
  });
});
