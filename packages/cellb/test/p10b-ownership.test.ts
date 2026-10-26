import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  createCellRuntime,
  DurableObject,
  filesApiChangeLog,
  runInDurableObject,
} from "../src/index.js";
import { nodeSqliteOpener } from "../src/node.js";
import { FakeClock } from "./fake-clock.js";
import { MemoryLeases } from "./memory-lease.js";

class Account extends DurableObject {
  async alarm() {
    const fired = ((await this.ctx.storage.get<number>("fired")) ?? 0) + 1;
    await this.ctx.storage.put("fired", fired);
  }
}

/**
 * Two "nodes" share a bucket (FilesApi for the log, leases beside it). Per-cell
 * ownership as in celld: a lease per cell, its epoch fencing the log; a takeover restores the
 * cell from the log and continues; the old owner stops serving when its lease is lost.
 */
function node(name: string, files: MemFilesApi, leases: MemoryLeases, clock: FakeClock) {
  const log = filesApiChangeLog(files);
  return createCellRuntime({
    worker: { Account, default: {} },
    durableObjects: { ACCOUNT: { className: "Account" } },
    openSql: nodeSqliteOpener(), // each node has its own (empty) local disk
    storage: { ...log, ownership: leases.for(name) },
    clock,
  });
}

describe("P10b per-cell ownership with lease epochs fencing the log", () => {
  it("one owner per cell; after the owner is partitioned (its lease lost), the next node restores from the log and continues", async () => {
    const clock = new FakeClock(1_000_000);
    const files = new MemFilesApi();
    const leases = new MemoryLeases();
    const nodeA = node("A", files, leases, clock);
    const nodeB = node("B", files, leases, clock);
    const cellA = (nodeA.env.ACCOUNT as any).getByName("acc-1");
    const cellB = (nodeB.env.ACCOUNT as any).getByName("acc-1");

    await runInDurableObject(cellA, (_o, ctx) => ctx.storage.put("balance", 100));
    // B cannot open a cell A owns.
    await expect(
      runInDurableObject(cellB, (_o, ctx) => ctx.storage.get("balance")),
    ).rejects.toThrow(/owned by another node/);

    // A is partitioned: its lease is lost, so it must stop serving.
    leases.partition("A");
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
    const leases = new MemoryLeases();
    const nodeA = node("A", files, leases, clock);
    const nodeB = node("B", files, leases, clock);
    const cellA = (nodeA.env.ACCOUNT as any).getByName("acc-2");
    // Due after A has lost its lease: A cannot fire it.
    await runInDurableObject(cellA, (_o, ctx) => ctx.storage.setAlarm(clock.now() + 11_000));
    leases.partition("A");
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
