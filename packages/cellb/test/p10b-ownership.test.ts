import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import {
  CasLease,
  createCellRuntime,
  DurableObject,
  filesApiChangeLog,
  MemoryConditionalStore,
  runInDurableObject,
} from "../src/index.js";
import type { ConditionalStore } from "../src/lease/conditional-store.js";
import { FakeClock } from "./fake-clock.js";

class Account extends DurableObject {
  async alarm() {
    const fired = ((await this.ctx.storage.get<number>("fired")) ?? 0) + 1;
    await this.ctx.storage.put("fired", fired);
  }
}

/**
 * Two "nodes" share a bucket (FilesApi for the log, conditional store for leases). Per-cell
 * ownership as in celld: a lease per cell, its epoch fencing the log; a takeover restores the
 * cell from the log and continues; the old owner stops serving when its lease is lost.
 */
function node(name: string, files: MemFilesApi, store: ConditionalStore, clock: FakeClock) {
  const log = filesApiChangeLog(files);
  return createCellRuntime({
    worker: { Account, default: {} },
    durableObjects: { ACCOUNT: { className: "Account" } },
    openSql: nodeSqliteOpener(), // each node has its own (empty) local disk
    durability: log,
    backup: log,
    ownership: new CasLease({
      store,
      owner: name,
      clock,
      ttlMs: 10_000,
      renewEveryMs: 3_000,
      skewMarginMs: 1_000,
    }),
    clock,
  });
}

/** A store that can be cut off from one node (network partition / crash). */
function partitionable(store: ConditionalStore) {
  let down = false;
  const view = new Proxy(store, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      return typeof v === "function"
        ? (...a: unknown[]) => (down ? Promise.reject(new Error("partitioned")) : v.apply(t, a))
        : v;
    },
  });
  return { view, cut: () => (down = true) };
}

describe("P10b per-cell ownership with lease epochs fencing the log", () => {
  it("one owner per cell; takeover after the lease expires restores from the log and continues", async () => {
    const clock = new FakeClock(1_000_000);
    const files = new MemFilesApi();
    const store = new MemoryConditionalStore();
    const a = partitionable(store);
    const nodeA = node("A", files, a.view, clock);
    const nodeB = node("B", files, store, clock);
    const cellA = (nodeA.env.ACCOUNT as any).getByName("acc-1");
    const cellB = (nodeB.env.ACCOUNT as any).getByName("acc-1");

    await runInDurableObject(cellA, (_o, ctx) => ctx.storage.put("balance", 100));
    // B cannot open a cell A owns.
    await expect(
      runInDurableObject(cellB, (_o, ctx) => ctx.storage.get("balance")),
    ).rejects.toThrow(/owned by another node/);

    // A is partitioned: it cannot renew; after ttl - skew it must stop serving.
    a.cut();
    await clock.advance(12_000);
    await expect(
      runInDurableObject(cellA, (_o, ctx) => ctx.storage.put("balance", 0)),
    ).rejects.toThrow(/lease .* lost|owned by another node|partitioned/);

    // B takes over (epoch 2), restores A's acknowledged write from the log, continues.
    const cellB2 = (nodeB.env.ACCOUNT as any).getByName("acc-1");
    expect(await runInDurableObject(cellB2, (_o, ctx) => ctx.storage.get("balance"))).toBe(100);
    await runInDurableObject(cellB2, (_o, ctx) => ctx.storage.put("balance", 150));

    // The log carries both owners' epochs, and a restore anywhere sees B's state.
    const segs: string[] = [];
    for await (const f of files.list("/cells", { recursive: true }))
      if (f.path.endsWith(".seg")) segs.push(f.path.split("/").pop()!.split("-")[0]);
    expect(new Set(segs.map(Number))).toEqual(new Set([1, 2]));
  });

  it("a cell taken over with a pending alarm: the new owner fires it", async () => {
    const clock = new FakeClock(1_000_000);
    const files = new MemFilesApi();
    const store = new MemoryConditionalStore();
    const a = partitionable(store);
    const nodeA = node("A", files, a.view, clock);
    const nodeB = node("B", files, store, clock);
    const cellA = (nodeA.env.ACCOUNT as any).getByName("acc-2");
    // Due after A has lost its lease (ttl - skew = 9 s): A cannot fire it.
    await runInDurableObject(cellA, (_o, ctx) => ctx.storage.setAlarm(clock.now() + 11_000));
    a.cut();
    await clock.advance(12_000);

    // B takes the cell over; its restored alarm is overdue and B now owns it.
    const cellB = (nodeB.env.ACCOUNT as any).getByName("acc-2");
    expect(await runInDurableObject(cellB, (_o, ctx) => ctx.storage.get("fired"))).toBe(undefined);
    await clock.advance(0);
    expect(
      await runInDurableObject(cellB, async (_o, ctx) => [
        await ctx.storage.get("fired"),
        await ctx.storage.getAlarm(),
      ]),
    ).toEqual([1, null]);
  });
});
