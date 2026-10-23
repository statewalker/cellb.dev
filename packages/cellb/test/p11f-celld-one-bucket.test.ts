import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { wasmMemoryOpener } from "../src/adapters/wasm-sqlite.js";
import { celldBucket } from "../src/bucket/celld-cells.js";
import { sqliteObjectStore } from "../src/bucket/sqlite-object-store.js";
import type { OpenCellSql } from "../src/ports.js";
import { loadNodeProject } from "../src/project/node-project.js";

// Interop the way it is meant to be used: celld and webrun-cells share ONE bucket (celld dev's
// objects.sqlite3) and hand cells over through celld's own ownership protocol — own.json
// epochs, node leases — with no manual step. Each project: celld, then webrun-cells, then
// celld again; the state continues on each side.
const CELLD = process.env.CELLD_BIN;
const ESBUILD_DIR = process.env.ESBUILD_DIR ?? "";
let port = 18_830;

async function celldDev(
  dir: string,
): Promise<{ p: ChildProcess; base: string; log: () => string }> {
  const at = port++;
  const p = spawn(CELLD!, ["dev", ".", "--port", String(at), "--logs"], {
    cwd: dir,
    env: { ...process.env, PATH: `${ESBUILD_DIR}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  p.stdout!.on("data", (d) => (log += d));
  p.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 150 && !log.includes("ready"); i++)
    await new Promise((r) => setTimeout(r, 200));
  if (!log.includes("ready")) throw new Error(`celld dev did not start:\n${log.slice(-2500)}`);
  return { p, base: `http://127.0.0.1:${at}`, log: () => log };
}
const stop = (p: ChildProcess) =>
  new Promise<void>((r) => {
    p.once("exit", () => r());
    p.kill("SIGTERM");
  });

const wasm = async (): Promise<OpenCellSql> =>
  wasmMemoryOpener(
    await ((await import("@sqlite.org/sqlite-wasm")).default as any)({ print() {}, printErr() {} }),
  );

/** celld (steps) → webrun-cells (steps) → celld (steps); each step's answer is compared. */
async function roundTrip(
  project: string,
  driver: "node" | "wasm",
  steps: { celld1: [string, unknown][]; webrun: [string, unknown][]; celld2: [string, unknown][] },
) {
  const dir = join(mkdtempSync(join(tmpdir(), "one-bucket-")), "p");
  cpSync(project, dir, { recursive: true });
  const answer = async (fetcher: (path: string) => Promise<Response>, path: string) => {
    const text = await (await fetcher(path)).text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  let celld = await celldDev(dir);
  for (const [path, want] of steps.celld1)
    expect(await answer((p) => fetch(celld.base + p), path)).toEqual(want);
  await stop(celld.p);

  const store = sqliteObjectStore(join(dir, ".celld/dev/objects.sqlite3"));
  const bucket = celldBucket(store, { node: "webrun-test", leaseTtlMs: 3_000 });
  const { runtime } = await loadNodeProject(dir, {
    openSql: driver === "node" ? nodeSqliteOpener() : await wasm(),
    files: new MemFilesApi(),
    ownership: bucket.ownership,
    durability: bucket.durability,
    backup: bucket.durability,
  } as never);
  const fetchW = (p: string) => runtime.fetch(new Request(`http://w${p}`));
  // celld's node lease may still be live for a moment: a refused step ("owned by another
  // node", before any code ran) is retried until the hand-over.
  for (const [path, want] of steps.webrun) {
    let got: unknown;
    for (let i = 0; i < 40; i++) {
      got = await answer(fetchW, path);
      if (!(typeof got === "string" && got.includes("owned by another"))) break;
      await new Promise((r2) => setTimeout(r2, 500));
    }
    expect(got).toEqual(want);
  }
  await runtime.close();
  await bucket.close();
  store.close();
  await new Promise((r) => setTimeout(r, 3_500)); // webrun-test's node lease expires

  celld = await celldDev(dir);
  try {
    for (const [path, want] of steps.celld2) {
      const got = await answer((p) => fetch(celld.base + p), path);
      expect(
        got,
        celld
          .log()
          .split("\n")
          .filter((l) => /restore|ltx|error/i.test(l))
          .slice(-15)
          .join("\n"),
      ).toEqual(want);
    }
  } finally {
    await stop(celld.p);
  }
}

const examples = resolve(__dirname, "../conformance/celld-examples");
const ours = resolve(__dirname, "../conformance/projects");
const valuesRead = () =>
  JSON.parse(readFileSync(resolve(__dirname, "../conformance/golden/kv-values.json"), "utf8"))
    .transcript[1].body;

describe.skipIf(!CELLD)(
  "P11f celld ⇄ webrun-cells through one bucket (celld's ownership protocol)",
  () => {
    for (const driver of ["node", "wasm"] as const) {
      it(
        `counter (${driver})`,
        () =>
          roundTrip(join(examples, "counter"), driver, {
            celld1: [["/increment?name=a", { n: 1, url: expect.any(String) }]],
            webrun: [["/increment?name=a", { n: 2, url: expect.any(String) }]],
            celld2: [["/increment?name=a", { n: 3, url: expect.any(String) }]],
          }),
        120_000,
      );

      it(
        `a facet's state (${driver})`,
        () =>
          roundTrip(join(ours, "facet-store"), driver, {
            celld1: [["/", { facet: 1, parent: 1 }]],
            webrun: [["/", { facet: 2, parent: 2 }]],
            celld2: [["/", { facet: 3, parent: 3 }]],
          }),
        120_000,
      );

      it(
        `celld's facets example — a Worker-Loader facet (${driver})`,
        () =>
          roundTrip(join(examples, "facets"), driver, {
            celld1: [["/", "0:hello, facet"]],
            webrun: [["/", "1:hello, facet"]],
            celld2: [["/", "2:hello, facet"]],
          }),
        120_000,
      );

      it(
        `stored values of every kind (${driver})`,
        () =>
          roundTrip(join(ours, "kv-values"), driver, {
            celld1: [["/write", "written"]],
            webrun: [
              ["/read", valuesRead()],
              ["/write", "written"],
            ],
            celld2: [["/read", valuesRead()]],
          }),
        120_000,
      );
    }

    // Alarms cross through celld's wake index: an alarm armed on one side fires on the other.
    it("an alarm armed in webrun-cells fires in celld", async () => {
      const dir = join(mkdtempSync(join(tmpdir(), "alarm-a-")), "alarm");
      cpSync(join(examples, "alarm"), dir, { recursive: true });
      let celld = await celldDev(dir); // creates the bucket (deploy), no alarm yet
      expect(await (await fetch(`${celld.base}/`)).json()).toEqual({
        fires: 0,
        pendingAlarm: null,
      });
      await stop(celld.p);
      const store = sqliteObjectStore(join(dir, ".celld/dev/objects.sqlite3"));
      const bucket = celldBucket(store, { node: "webrun-test", leaseTtlMs: 3_000 });
      const { runtime } = await loadNodeProject(dir, {
        openSql: nodeSqliteOpener(),
        files: new MemFilesApi(),
        ownership: bucket.ownership,
        durability: bucket.durability,
        backup: bucket.durability,
      } as never);
      let armed: any;
      for (let i = 0; i < 40; i++) {
        armed = await (await runtime.fetch(new Request("http://w/arm"))).text();
        if (!armed.includes("owned by another")) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(JSON.parse(armed).armed).toBe(true);
      await runtime.close(); // before the alarm is due
      await bucket.close();
      expect((await store.list("wake/entries/")).length).toBeGreaterThan(0);
      store.close();
      await new Promise((r) => setTimeout(r, 3_500));
      celld = await celldDev(dir);
      try {
        let got: any;
        for (let i = 0; i < 30; i++) {
          got = await (await fetch(`${celld.base}/`)).json();
          if (got.fires) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        expect(
          got,
          celld
            .log()
            .split("\n")
            .filter((l) => /wake|alarm/i.test(l))
            .slice(-10)
            .join("\n"),
        ).toEqual({ fires: 1, pendingAlarm: null });
      } finally {
        await stop(celld.p);
      }
    }, 120_000);

    it("an alarm armed in celld fires in webrun-cells", async () => {
      const dir = join(mkdtempSync(join(tmpdir(), "alarm-b-")), "alarm");
      cpSync(join(examples, "alarm"), dir, { recursive: true });
      const celld = await celldDev(dir);
      expect((await (await fetch(`${celld.base}/arm`)).json()).armed).toBe(true);
      await stop(celld.p); // before the alarm is due (2 s)
      const store = sqliteObjectStore(join(dir, ".celld/dev/objects.sqlite3"));
      const bucket = celldBucket(store, { node: "webrun-test", leaseTtlMs: 3_000 });
      const { runtime } = await loadNodeProject(dir, {
        openSql: nodeSqliteOpener(),
        files: new MemFilesApi(),
        ownership: bucket.ownership,
        durability: bucket.durability,
        backup: bucket.durability,
      } as never);
      try {
        let got: any;
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const text = await (await runtime.fetch(new Request("http://w/"))).text();
          if (text.includes("owned by another")) continue;
          got = JSON.parse(text);
          if (got.fires) break;
        }
        expect(got).toEqual({ fires: 1, pendingAlarm: null });
      } finally {
        await runtime.close();
        await bucket.close();
        store.close();
      }
    }, 120_000);

    it("a failing alarm's retries continue across runtimes (retry count in the alarm row)", async () => {
      const dir = join(mkdtempSync(join(tmpdir(), "alarm-retry-")), "alarm-retry");
      cpSync(join(ours, "alarm-retry"), dir, { recursive: true });
      // celld: armed in 300 ms; the first attempt (retryCount 0) fails and is rescheduled
      // 2 s later — celld stops before that retry.
      const celld = await celldDev(dir);
      await fetch(`${celld.base}/arm?in=300`);
      await new Promise((r) => setTimeout(r, 1_200));
      expect(await (await fetch(`${celld.base}/`)).json()).toEqual({
        attempts: [0],
        done: null,
        pending: true,
      });
      await stop(celld.p);
      // webrun-cells finds the retry in the wake index and continues the count.
      const store = sqliteObjectStore(join(dir, ".celld/dev/objects.sqlite3"));
      const bucket = celldBucket(store, { node: "webrun-test", leaseTtlMs: 3_000 });
      const { runtime } = await loadNodeProject(dir, {
        openSql: nodeSqliteOpener(),
        files: new MemFilesApi(),
        ownership: bucket.ownership,
        durability: bucket.durability,
        backup: bucket.durability,
      } as never);
      try {
        let got: any;
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const text = await (await runtime.fetch(new Request("http://w/"))).text();
          if (text.includes("owned by another")) continue;
          got = JSON.parse(text);
          if (got.done) break;
        }
        expect(got).toEqual({
          attempts: [0, 1, 2],
          done: { retryCount: 2, isRetry: true },
          pending: false,
        });
      } finally {
        await runtime.close();
        await bucket.close();
        store.close();
      }
    }, 120_000);
  },
);
