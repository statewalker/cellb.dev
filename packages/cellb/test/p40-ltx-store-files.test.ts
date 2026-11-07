/**
 * The LTX store on a FilesApi the app opened itself: over a MessagePort (files-rpc), and in the
 * caller's thread (serveLtxStore). The VFS's synchronous wait is replaced here by
 * Atomics.waitAsync: the same shared-buffer protocol, without blocking the test's thread.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterEach, describe, expect, it } from "vitest";
import { rpcFilesClient, serveFilesApi } from "../src/ltx/files-rpc.js";
import { serveLtxStore } from "../src/ltx/ltx-host.js";
import { type LtxStoreMessage, ltxCellStore } from "../src/ltx/ltx-page-server.js";

/** ES2024's Atomics.waitAsync (Node 16+), beyond this package's `lib`. */
type AtomicsWaitAsync = {
  waitAsync(
    a: Int32Array,
    i: number,
    v: number,
    t?: number,
  ): { async: false; value: string } | { async: true; value: Promise<string> };
};

const PAGE = 4096;
const CELL = "Notes/0001";
const DIR = "/cells/Notes:0001/ltx/e1/0000";
const page = (seed: number) => new Uint8Array(PAGE).map((_, i) => (seed * 131 + i) & 255);

/**
 * One VFS request, answered into `sab` (as installLtxVfs's `call`, but awaiting): numbered, and
 * an answer tagged with another number (a request given up on) is not taken for this one's.
 */
function caller(sab: SharedArrayBuffer, post: (m: LtxStoreMessage & { seq: number }) => void) {
  const ctl = new Int32Array(sab, 0, 2);
  const payload = new Uint8Array(sab, 8);
  let seq = 0;
  const call = async (msg: Omit<LtxStoreMessage, "cell"> & { cell?: string }) => {
    const mine = ++seq;
    Atomics.store(ctl, 0, 0);
    post({ cell: CELL, ...msg, seq: mine } as LtxStoreMessage & { seq: number });
    let word = 0;
    for (;;) {
      const w = (Atomics as unknown as AtomicsWaitAsync).waitAsync(ctl, 0, 0, 10_000);
      if (w.async && (await w.value) === "timed-out") throw new Error("no answer");
      word = Atomics.load(ctl, 0);
      if (word >>> 2 === mine) break;
      Atomics.compareExchange(ctl, 0, word, 0); // a late answer to an earlier request
    }
    if ((word & 3) === 2) throw new Error(new TextDecoder().decode(payload.slice(0, ctl[1])));
    return payload.slice(0, ctl[1]);
  };
  /** Posts a request and does not wait for it (a VFS that gave up on it). */
  const abandon = (msg: Omit<LtxStoreMessage, "cell">) => {
    const mine = ++seq;
    Atomics.store(ctl, 0, 0);
    post({ cell: CELL, ...msg, seq: mine } as LtxStoreMessage & { seq: number });
  };
  return Object.assign(call, { abandon });
}

const ltxFiles = async (files: FilesApi) => {
  const out: string[] = [];
  if (!(await files.exists(DIR))) return out;
  for await (const e of files.list(DIR)) out.push(e.name);
  return out;
};

/** Commits `n` transactions: page 1 and page (k+1) changed by commit k. */
async function commitMany(call: ReturnType<typeof caller>, n: number, from = 0) {
  for (let k = from; k < from + n; k++)
    await call({
      op: "commit",
      pageSize: PAGE,
      pageCount: Math.max(2, k + 2),
      pages: [
        [1, page(1000 + k)],
        [k + 2, page(k + 2)],
      ],
    });
}
async function expectPages(call: ReturnType<typeof caller>, last: number) {
  const meta = JSON.parse(new TextDecoder().decode(await call({ op: "meta" })));
  expect(meta).toEqual({ pageSize: PAGE, pageCount: last + 2 });
  expect(await call({ op: "read", pgno: 1 })).toEqual(page(1000 + last));
  for (let p = 2; p <= last + 2; p++) expect(await call({ op: "read", pgno: p })).toEqual(page(p));
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe("the LTX store on the app's FilesApi", () => {
  it("runs in a worker's place on a FilesApi served over a port: commits, reads, compacts", async () => {
    const files = new MemFilesApi(); // the app's own storage, in "the page"
    const ch = new MessageChannel();
    cleanups.push(serveFilesApi(ch.port1, files), () => ch.port1.close());
    const sab = new SharedArrayBuffer(8 + 16 * 65536);
    const store = ltxCellStore(rpcFilesClient(ch.port2), sab, {
      lockScope: "app",
      autoCompact: false,
      room: async () => undefined,
    });
    cleanups.push(() => store.close());
    const call = caller(sab, (m) => store.handle(m));
    await commitMany(call, 5);
    expect(await ltxFiles(files)).toHaveLength(5); // written through the port
    await expectPages(call, 4);
    const run = await call({ op: "readRun", pgno: 1, count: 6 });
    expect(run.length).toBe(6 * PAGE);
    expect(run.subarray(5 * PAGE)).toEqual(page(6));
    expect(await store.compact(CELL)).toBe(1);
    expect(await ltxFiles(files)).toEqual(["0000000000000001-0000000000000005.ltx"]);
    await expectPages(call, 4);
    await commitMany(call, 2, 5);
    await expectPages(call, 6);
  });

  it("runs in the caller's thread on the instance (serveLtxStore), the VFS behind a port", async () => {
    const files = new MemFilesApi();
    const served = serveLtxStore(files, { lockScope: "app", compactAfter: 4 });
    cleanups.push(() => served.close());
    // The shard worker's side: its VFS posts to the port and waits on the shared buffer.
    const call = caller(served.sab, (m) => served.port.postMessage(m));
    await commitMany(call, 10);
    await expectPages(call, 9);
    for (let i = 0; i < 50 && (await ltxFiles(files)).length >= 4; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect((await ltxFiles(files)).length).toBeLessThan(4); // compacted past compactAfter
    await expectPages(call, 9);
  });

  it("keeps a cell whose compaction stopped between the snapshot and the removals", async () => {
    const files = new MemFilesApi();
    const sab = new SharedArrayBuffer(8 + 16 * 65536);
    // The connection to the storage drops after the snapshot is moved into place.
    let dropped = false;
    const flaky: FilesApi = Object.assign(Object.create(files), {
      async move(a: string, b: string) {
        const ok = await files.move(a, b);
        dropped = true;
        return ok;
      },
      async remove(p: string) {
        if (dropped) throw new Error("connection lost");
        return files.remove(p);
      },
    });
    const first = ltxCellStore(flaky, sab, { autoCompact: false, room: async () => undefined });
    const call1 = caller(sab, (m) => first.handle(m));
    await commitMany(call1, 4);
    await expect(first.compact(CELL)).rejects.toThrow("connection lost");
    // The store's own view is the snapshot now, not the files the failed removes left behind.
    expect(await first.files(CELL)).toEqual([`${DIR}/0000000000000001-0000000000000004.ltx`]);
    await first.close();
    // Snapshot 1-4 beside the files it covers: the cell opens from the snapshot, and the
    // leftovers go.
    expect((await ltxFiles(files)).sort()).toContain("0000000000000001-0000000000000004.ltx");
    expect((await ltxFiles(files)).length).toBeGreaterThan(1);
    const second = ltxCellStore(files, sab, { autoCompact: false, room: async () => undefined });
    cleanups.push(() => second.close());
    const call2 = caller(sab, (m) => second.handle(m));
    await expectPages(call2, 3);
    expect(await ltxFiles(files)).toEqual(["0000000000000001-0000000000000004.ltx"]);
    await commitMany(call2, 1, 4);
    await expectPages(call2, 4);
  });

  it("does not let the late answer to an abandoned request pass for the next one's", async () => {
    const files = new MemFilesApi();
    // Reads stall on the storage while `held` has gates: each read takes the next one.
    const held: { entered: () => void; gate: Promise<void> }[] = [];
    const hold = () => {
      let entered!: () => void;
      let release!: () => void;
      const inRead = new Promise<void>((r) => (entered = r));
      held.push({ entered, gate: new Promise<void>((r) => (release = r)) });
      return { inRead, release };
    };
    const slow: FilesApi = Object.assign(Object.create(files), {
      read(path: string, o?: { start?: number; length?: number }) {
        const inner = files.read(path, o);
        const h = held.shift();
        if (!h) return inner;
        h.entered();
        return (async function* () {
          await h.gate;
          yield* inner;
        })();
      },
    });
    const sab = new SharedArrayBuffer(8 + 16 * 65536);
    const store = ltxCellStore(slow, sab, { autoCompact: false, room: async () => undefined });
    cleanups.push(() => void store.close());
    const call = caller(sab, (m) => store.handle(m));
    await commitMany(call, 3);
    const a = hold();
    call.abandon({ op: "read", pgno: 2 }); // stalls on the storage; the VFS gives up on it
    await a.inRead;
    const b = hold();
    const next = call({ op: "read", pgno: 3 });
    a.release(); // the abandoned request's answer lands while the next one waits
    await b.inRead;
    await new Promise((r) => setTimeout(r, 20));
    b.release();
    expect(await next).toEqual(page(3)); // not page 2, the abandoned request's answer
  });

  it("keeps a commit made while a compaction reopens the cell", async () => {
    const files = new MemFilesApi();
    // The first listing after the swap's move (the compaction's reopen) is slow: a reopen outside
    // the request queue would finish after a commit sent meanwhile, with a view lacking it.
    let moved = false;
    let slowOnce = false;
    const lagging: FilesApi = Object.assign(Object.create(files), {
      async move(a: string, b: string) {
        const ok = await files.move(a, b);
        moved = slowOnce = true;
        return ok;
      },
      async *list(path: string, o?: { recursive?: boolean }) {
        const slow = slowOnce;
        slowOnce = false;
        const entries = [];
        for await (const e of files.list(path, o)) entries.push(e);
        if (slow) await new Promise((r) => setTimeout(r, 150)); // listed, then slow to answer
        yield* entries;
      },
    });
    const sab = new SharedArrayBuffer(8 + 16 * 65536);
    const store = ltxCellStore(lagging, sab, { autoCompact: false, room: async () => undefined });
    cleanups.push(() => void store.close());
    const call = caller(sab, (m) => store.handle(m));
    await commitMany(call, 4);
    const compaction = store.compact(CELL);
    while (!moved) await new Promise((r) => setTimeout(r, 1));
    await commitMany(call, 1, 4); // TXID 5, sent while the compaction reopens the cell
    await compaction;
    await commitMany(call, 1, 5); // TXID 6: must not take 5's place
    await expectPages(call, 5);
    expect(await ltxFiles(files)).toContain("0000000000000005-0000000000000005.ltx");
  });

  it("refuses requests after close(), and finishes what was under way first", async () => {
    const files = new MemFilesApi();
    const sab = new SharedArrayBuffer(8 + 16 * 65536);
    const store = ltxCellStore(files, sab, { autoCompact: false, room: async () => undefined });
    const call = caller(sab, (m) => store.handle(m));
    await commitMany(call, 3);
    const compaction = store.compact(CELL);
    const closing = store.close();
    await expect(compaction).rejects.toThrow(/closed/);
    await closing;
    await expect(call({ op: "meta" })).rejects.toThrow(/closed/);
    // Nothing was swapped: the three files, no snapshot and no `.tmp` left.
    expect((await ltxFiles(files)).sort()).toEqual([
      "0000000000000001-0000000000000001.ltx",
      "0000000000000002-0000000000000002.ltx",
      "0000000000000003-0000000000000003.ltx",
    ]);
  });

  it("reads a cell from its files when a snapshot beside them does not open (a cut-short copy)", async () => {
    const files = new MemFilesApi();
    const sab = new SharedArrayBuffer(8 + 16 * 65536);
    const first = ltxCellStore(files, sab, { autoCompact: false, room: async () => undefined });
    const call1 = caller(sab, (m) => first.handle(m));
    await commitMany(call1, 3);
    await first.close();
    await files.write(`${DIR}/0000000000000001-0000000000000003.ltx`, [new Uint8Array(300)]);
    const second = ltxCellStore(files, sab, { autoCompact: false, room: async () => undefined });
    cleanups.push(() => void second.close());
    const call2 = caller(sab, (m) => second.handle(m));
    await expectPages(call2, 2);
  });
});
