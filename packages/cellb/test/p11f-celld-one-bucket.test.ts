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
  driver: "node" | "wasm" | "node-wal",
  steps: { celld1: [string, unknown][]; webrun: [string, unknown][]; celld2: [string, unknown][] },
) {
  const dir = join(mkdtempSync(join(tmpdir(), "one-bucket-")), "p");
  cpSync(project, dir, { recursive: true });
  // A step is "/path" or "METHOD /path [body]".
  const answer = async (
    fetcher: (path: string, init?: RequestInit) => Promise<Response>,
    step: string,
  ) => {
    const m = /^(GET|POST|PUT|DELETE) (\S+)(?: (.*))?$/s.exec(step);
    const text = await (
      await (m ? fetcher(m[2], { method: m[1], body: m[3] }) : fetcher(step))
    ).text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  let celld = await celldDev(dir);
  for (const [path, want] of steps.celld1)
    expect(await answer((p, init) => fetch(celld.base + p, init), path)).toEqual(want);
  await stop(celld.p);

  const store = sqliteObjectStore(join(dir, ".celld/dev/objects.sqlite3"));
  const bucket = celldBucket(store, { node: "webrun-test", leaseTtlMs: 3_000 });
  const { runtime } = await loadNodeProject(dir, {
    openSql:
      driver === "node"
        ? nodeSqliteOpener()
        : driver === "node-wal" // file-backed, WAL page capture
          ? nodeSqliteOpener(mkdtempSync(join(tmpdir(), "wal-cells-")), { pageCapture: true })
          : await wasm(),
    files: new MemFilesApi(),
    ownership: bucket.ownership,
    durability: bucket.durability,
    backup: bucket.durability,
    bucketStore: store, // R2 objects live directly in the fleet bucket
  } as never);
  const fetchW = (p: string, init?: RequestInit) =>
    runtime.fetch(new Request(`http://w${p}`, init));
  // celld's node lease may still be live for a moment: a refused step ("owned by another
  // node", before any code ran) is retried until the hand-over.
  for (const [path, want] of steps.webrun) {
    let got: unknown;
    for (let i = 0; i < 40; i++) {
      got = await answer(fetchW, path);
      if (!(typeof got === "string" && got.includes("owned by another"))) break;
      await new Promise((r2) => setTimeout(r2, 500));
    }
    expect(got, JSON.stringify(got)).toEqual(want);
  }
  await runtime.close();
  await bucket.close();
  store.close();
  await new Promise((r) => setTimeout(r, 3_500)); // webrun-test's node lease expires

  celld = await celldDev(dir);
  try {
    for (const [path, want] of steps.celld2) {
      const got = await answer((p, init) => fetch(celld.base + p, init), path);
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
    for (const driver of ["node", "wasm", "node-wal"] as const) {
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

    for (const driver of ["node", "wasm"] as const) {
      it(
        `D1: a guestbook continues across runtimes (${driver})`,
        () =>
          roundTrip(join(examples, "d1"), driver, {
            celld1: [['POST / {"name":"celld","message":"first"}', { id: 1, changes: 1 }]],
            webrun: [
              ["/count", { count: 1 }],
              ['POST / {"name":"webrun","message":"second"}', { id: 2, changes: 1 }],
            ],
            celld2: [
              ["/count", { count: 2 }],
              ['POST / {"name":"celld","message":"third"}', { id: 3, changes: 1 }],
            ],
          }),
        120_000,
      );

      it(
        `KV: values continue across runtimes (${driver})`,
        () =>
          roundTrip(join(examples, "kv"), driver, {
            celld1: [["PUT /greeting hello from celld", ""]],
            webrun: [
              ["/greeting", "hello from celld"],
              ["PUT /greeting hello from webrun-cells", ""],
            ],
            celld2: [["/greeting", "hello from webrun-cells"]],
          }),
        120_000,
      );
    }

    // Delayed messages are pending in the queue cell when it changes hands: the other side
    // delivers them (celld's queue schema and code on both sides).
    for (const driver of ["node", "wasm"] as const) {
      it(`Queues: messages sent on celld are delivered by webrun-cells, and back (${driver})`, async () => {
        const dir = join(mkdtempSync(join(tmpdir(), "queue-handoff-")), "queue-handoff");
        cpSync(join(ours, "queue-handoff"), dir, { recursive: true });
        let celld = await celldDev(dir);
        await fetch(`${celld.base}/send?body=a-from-celld&delay=3`);
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
        const logW = async () => {
          for (let i = 0; i < 60; i++) {
            const text = await (await runtime.fetch(new Request("http://w/"))).text();
            if (!text.includes("owned by another")) return JSON.parse(text);
            await new Promise((r) => setTimeout(r, 500));
          }
        };
        let got: any;
        for (let i = 0; i < 40; i++) {
          got = await logW();
          if (got.length) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        expect(got).toEqual([{ body: "a-from-celld", attempts: 1 }]);
        // and the other way: sent on webrun-cells (delayed), delivered by celld
        let sent = "";
        for (let i = 0; i < 40 && !sent.includes("sent"); i++)
          sent = await (
            await runtime.fetch(new Request("http://w/send?body=b-from-webrun&delay=4"))
          ).text();
        await runtime.close();
        await bucket.close();
        store.close();
        await new Promise((r) => setTimeout(r, 3_500));
        celld = await celldDev(dir);
        try {
          let log: any;
          for (let i = 0; i < 40; i++) {
            log = await (await fetch(`${celld.base}/`)).json();
            if (log.length === 2) break;
            await new Promise((r) => setTimeout(r, 500));
          }
          expect(log).toEqual([
            { body: "a-from-celld", attempts: 1 },
            { body: "b-from-webrun", attempts: 1 },
          ]);
        } finally {
          await stop(celld.p);
        }
      }, 150_000);
    }

    // A Workflow instance sleeping when its cell changes hands: the other side finishes it
    // from celld's records (finished steps are not run again: their counter stays 0 there).
    for (const driver of ["node", "wasm"] as const) {
      it(`Workflows: an instance started on celld finishes on webrun-cells, and back (${driver})`, async () => {
        const dir = join(mkdtempSync(join(tmpdir(), "wf-handoff-")), "workflow-api");
        cpSync(join(ours, "workflow-api"), dir, { recursive: true });
        let celld = await celldDev(dir);
        expect(await (await fetch(`${celld.base}/create?id=s1&kind=steps`)).json()).toEqual({
          id: "s1",
        });
        await new Promise((r) => setTimeout(r, 300)); // step "a" done, sleeping 2 s
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
        const status = async (id: string) => {
          for (let i = 0; i < 60; i++) {
            const text = await (
              await runtime.fetch(new Request(`http://w/status?id=${id}`))
            ).text();
            if (!text.includes("owned by another")) return JSON.parse(text);
            await new Promise((r) => setTimeout(r, 500));
          }
        };
        let st: any;
        for (let i = 0; i < 40; i++) {
          st = await status("s1");
          if (st.status === "complete") break;
          await new Promise((r) => setTimeout(r, 500));
        }
        expect(st).toMatchObject({ status: "complete", output: { a: 1, b: 2, stepARuns: 0 } });
        // the other way: started here, finished by celld
        let created = "";
        for (let i = 0; i < 40 && !created.includes("s2"); i++)
          created = await (
            await runtime.fetch(new Request("http://w/create?id=s2&kind=steps"))
          ).text();
        await new Promise((r) => setTimeout(r, 300));
        await runtime.close();
        await bucket.close();
        store.close();
        await new Promise((r) => setTimeout(r, 3_500));
        celld = await celldDev(dir);
        try {
          let st2: any;
          for (let i = 0; i < 40; i++) {
            st2 = await (await fetch(`${celld.base}/status?id=s2`)).json();
            if (st2.status === "complete") break;
            await new Promise((r) => setTimeout(r, 500));
          }
          expect(st2).toMatchObject({ status: "complete", output: { a: 1, b: 2, stepARuns: 0 } });
        } finally {
          await stop(celld.p);
        }
      }, 150_000);
    }

    // A queue is a cell (celld's own queue code on both sides): pending messages travel with it.
    const handoff = async (direction: "celld→webrun" | "webrun→celld") => {
      const dir = join(mkdtempSync(join(tmpdir(), "queue-handoff-")), "queue-handoff");
      cpSync(join(ours, "queue-handoff"), dir, { recursive: true });
      let celld = await celldDev(dir);
      const store = () => sqliteObjectStore(join(dir, ".celld/dev/objects.sqlite3"));
      const webrun = async () => {
        const st = store();
        const bucket = celldBucket(st, { node: `webrun-${Date.now()}`, leaseTtlMs: 3_000 });
        const { runtime } = await loadNodeProject(dir, {
          openSql: nodeSqliteOpener(),
          files: new MemFilesApi(),
          ownership: bucket.ownership,
          durability: bucket.durability,
          backup: bucket.durability,
        } as never);
        const call = async (path: string) => {
          for (let i = 0; i < 60; i++) {
            const text = await (await runtime.fetch(new Request(`http://w${path}`))).text();
            if (!text.includes("owned by another")) return JSON.parse(text);
            await new Promise((r) => setTimeout(r, 500));
          }
          throw new Error("never owned");
        };
        return {
          call,
          close: async () => {
            await runtime.close();
            await bucket.close();
            st.close();
          },
        };
      };
      if (direction === "celld→webrun") {
        await fetch(`${celld.base}/send?body=now`);
        await fetch(`${celld.base}/send?body=later&delay=8`); // pending at hand-over
        await new Promise((r) => setTimeout(r, 2_500));
        expect(await (await fetch(`${celld.base}/`)).json()).toEqual([
          { body: "now", attempts: 1 },
        ]);
        await stop(celld.p);
        const w = await webrun();
        try {
          let got: unknown[] = [];
          for (let i = 0; i < 40 && got.length < 2; i++) {
            await new Promise((r) => setTimeout(r, 500));
            got = await w.call("/");
          }
          expect(got).toEqual([
            { body: "later", attempts: 1 },
            { body: "now", attempts: 1 },
          ]);
        } finally {
          await w.close();
        }
      } else {
        await stop(celld.p); // deployed; the queue cell does not exist yet
        const w = await webrun();
        await w.call("/send?body=now");
        await w.call("/send?body=later&delay=8");
        await new Promise((r) => setTimeout(r, 2_500));
        expect(await w.call("/")).toEqual([{ body: "now", attempts: 1 }]);
        await w.close();
        await new Promise((r) => setTimeout(r, 3_500));
        celld = await celldDev(dir);
        try {
          let got: unknown[] = [];
          for (let i = 0; i < 40 && got.length < 2; i++) {
            await new Promise((r) => setTimeout(r, 500));
            got = await (await fetch(`${celld.base}/`)).json();
          }
          expect(
            got,
            celld
              .log()
              .split("\n")
              .filter((l) => /queue|restore|wake/i.test(l))
              .slice(-10)
              .join("\n"),
          ).toEqual([
            { body: "later", attempts: 1 },
            { body: "now", attempts: 1 },
          ]);
        } finally {
          await stop(celld.p);
        }
      }
    };
    it(
      "Queues: a delayed message sent on celld is delivered by webrun-cells",
      () => handoff("celld→webrun"),
      120_000,
    );
    it(
      "Queues: a delayed message sent on webrun-cells is delivered by celld",
      () => handoff("webrun→celld"),
      120_000,
    );

    // A workflow instance is a cell (celld's own workflow code on both sides): a sleeping or
    // waiting instance resumes on the other runtime, with its finished steps memoized.
    const flow = async (direction: "celld→webrun" | "webrun→celld") => {
      const dir = join(mkdtempSync(join(tmpdir(), "workflow-handoff-")), "workflow-api");
      cpSync(join(ours, "workflow-api"), dir, { recursive: true });
      let celld = await celldDev(dir);
      const webrun = async () => {
        const st = sqliteObjectStore(join(dir, ".celld/dev/objects.sqlite3"));
        const bucket = celldBucket(st, { node: `webrun-${Date.now()}`, leaseTtlMs: 3_000 });
        const { runtime } = await loadNodeProject(dir, {
          openSql: nodeSqliteOpener(),
          files: new MemFilesApi(),
          ownership: bucket.ownership,
          durability: bucket.durability,
          backup: bucket.durability,
        } as never);
        const call = async (path: string) => {
          for (let i = 0; i < 60; i++) {
            const text = await (await runtime.fetch(new Request(`http://w${path}`))).text();
            if (!text.includes("owned by another")) return JSON.parse(text);
            await new Promise((r) => setTimeout(r, 500));
          }
          throw new Error("never owned");
        };
        return {
          call,
          close: async () => (await runtime.close(), await bucket.close(), st.close()),
        };
      };
      const celldCall = async (path: string) => (await fetch(`${celld.base}${path}`)).json();
      const settle = async (call: (p: string) => Promise<any>, id: string) => {
        let s: any;
        for (let i = 0; i < 40; i++) {
          s = await call(`/status?id=${id}`);
          if (s.status === "complete" || s.status === "errored") break;
          await new Promise((r) => setTimeout(r, 500));
        }
        return s;
      };
      if (direction === "celld→webrun") {
        await celldCall("/create?id=s1&kind=steps"); // step a runs, then a 2 s sleep
        await celldCall("/create?id=e1&kind=event"); // waits for an event
        await new Promise((r) => setTimeout(r, 600));
        expect((await celldCall("/status?id=s1")).status).toBe("waiting");
        await stop(celld.p);
        const w = await webrun();
        try {
          // The sleep ends on webrun-cells; step a is NOT run again (memoized in celld's records:
          // this process's run counter stays 0).
          expect(await settle(w.call, "s1")).toEqual(
            expect.objectContaining({ status: "complete", output: { a: 1, b: 2, stepARuns: 0 } }),
          );
          await w.call("/event?id=e1");
          expect(await settle(w.call, "e1")).toEqual(
            expect.objectContaining({
              status: "complete",
              output: { approved: { by: "ada" }, type: "approve" },
            }),
          );
        } finally {
          await w.close();
        }
      } else {
        await stop(celld.p);
        const w = await webrun();
        await w.call("/create?id=s2&kind=steps");
        await w.call("/create?id=e2&kind=event");
        await new Promise((r) => setTimeout(r, 600));
        expect((await w.call("/status?id=s2")).status).toBe("waiting");
        await w.close();
        await new Promise((r) => setTimeout(r, 3_500));
        celld = await celldDev(dir);
        try {
          expect(await settle(celldCall, "s2")).toEqual(
            expect.objectContaining({ status: "complete", output: { a: 1, b: 2, stepARuns: 0 } }),
          );
          await celldCall("/event?id=e2");
          expect(await settle(celldCall, "e2")).toEqual(
            expect.objectContaining({
              status: "complete",
              output: { approved: { by: "ada" }, type: "approve" },
            }),
          );
        } finally {
          await stop(celld.p);
        }
      }
    };
    it(
      "Workflows: a sleeping and a waiting instance from celld complete in webrun-cells",
      () => flow("celld→webrun"),
      120_000,
    );
    it(
      "Workflows: a sleeping and a waiting instance from webrun-cells complete in celld",
      () => flow("webrun→celld"),
      120_000,
    );

    for (const driver of ["node", "wasm", "node-wal"] as const) {
      const note = (body: string, who: string) => ({
        body,
        size: body.length,
        httpMetadata: {
          contentType: "text/x-note",
          contentLanguage: "fr",
          cacheExpiry: "2030-01-01T00:00:00.000Z",
        },
        customMetadata: { Who: who, note: "déjà vu ✓" },
        md5: expect.stringMatching(/^[0-9a-f]{32}$/),
        range: body.slice(1, 4),
      });
      it(
        `R2: objects with their metadata move across runtimes (${driver})`,
        () =>
          roundTrip(join(ours, "r2-handoff"), driver, {
            celld1: [["/put?key=a/one&body=written-by-celld&who=celld", { put: "a/one" }]],
            webrun: [
              ["/get?key=a/one", note("written-by-celld", "celld")],
              ["/put?key=b/two&body=written-by-webrun&who=webrun", { put: "b/two" }],
              ["/list", ["a/one", "b/two"]],
            ],
            celld2: [
              ["/get?key=b/two", note("written-by-webrun", "webrun")],
              ["/list", ["a/one", "b/two"]],
            ],
          }),
        120_000,
      );
    }
  },
);
