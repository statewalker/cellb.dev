import { type ChildProcess, fork } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteFileLease } from "../src/adapters/sqlite-lease.js";

describe("P05c single-host lease: SQLite file in EXCLUSIVE locking mode (OS lock)", () => {
  let holder = "";
  const dir = mkdtempSync(join(tmpdir(), "cells-lease-"));
  const children: ChildProcess[] = [];
  beforeAll(async () => {
    holder = join(dir, "lease-holder.mjs");
    await build({
      entryPoints: [join(__dirname, "lease-holder.entry.ts")],
      outfile: holder,
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
  afterAll(() => {
    for (const c of children) c.kill("SIGKILL");
  });
  const child = (name: string, mode = "hold") =>
    new Promise<{ proc: ChildProcess; msg: any }>((resolve) => {
      const proc = fork(holder, [join(dir, "locks"), name, mode], { execArgv: ["--no-warnings"] });
      children.push(proc);
      proc.once("message", (msg) => resolve({ proc, msg }));
    });

  it("excludes other processes and other connections of the same process", async () => {
    const a = await child("shard-0");
    expect(a.msg.type).toBe("held");
    expect((await child("shard-0", "try")).msg.type).toBe("busy"); // another process
    expect(await new SqliteFileLease(join(dir, "locks")).tryAcquire("shard-0")).toBeUndefined(); // this process
    expect((await child("shard-1", "try")).msg.type).toBe("held"); // other names are independent
    a.proc.kill("SIGKILL");
  });

  it("is released by the OS when the holder is killed (kill -9): no stale lock, epoch increases", async () => {
    const a = await child("shard-2");
    const lease = new SqliteFileLease(join(dir, "locks"));
    expect(await lease.tryAcquire("shard-2")).toBeUndefined();
    const died = new Promise((r) => a.proc.once("exit", r));
    a.proc.kill("SIGKILL");
    await died;
    const t0 = Date.now();
    const h = await lease.tryAcquire("shard-2");
    expect(h).toBeDefined();
    expect(Date.now() - t0).toBeLessThan(100);
    expect(h!.epoch).toBe(a.msg.epoch + 1);
    await h!.release();
    expect((await lease.tryAcquire("shard-2"))!.epoch).toBe(a.msg.epoch + 2);
  });
});
