import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryObjectStore, type ObjectStore } from "../src/index.js";
import {
  createLogFollower,
  decodeTail,
  encodeAppend,
  type ShipEntry,
} from "../src/peer/log-follower.js";

// A cellb node as a follower in celld's log tier (celld 0.6.3 crates/celld/node_log.rs,
// logic/log_tier.rs): it holds the LTX segments a celld leader ships before the bucket does, so
// the leader can acknowledge on it, and hands them back to the node that recovers a dead leader
// (statewalker/cellb.dev#208).
const enc = new TextEncoder();
const hex = (s: string) => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ""), "hex"));

/** A leader's node record, as celld writes it, with an open log naming `ensemble`. */
async function leaderRecord(
  store: ObjectStore,
  o: { node?: string; gen?: string; epoch: number; state?: string; ensemble?: string[] },
) {
  const node = o.node ?? "a";
  await store.put(
    `nodes/${node}.json`,
    enc.encode(
      JSON.stringify({
        node,
        expires_ms: Date.now() + 60_000,
        addr: "127.0.0.1:1",
        probe_public_key: o.gen ?? "g1",
        ownership_index_generation: o.gen ?? "g1",
        peer_protocol: 5,
        log: {
          state: o.state ?? "open",
          epoch: o.epoch,
          ensemble: o.ensemble ?? ["me"],
          tiered: 0,
          active: true,
          claimant: null,
          claimed_ms: null,
        },
      }),
    ),
  );
}
const entry = (seq: number, txid = seq): ShipEntry => ({
  seq,
  cell: "Counter:00",
  cellEpoch: 1,
  txid,
  bytes: enc.encode(`ltx-${seq}`),
});
const batch = (epoch: number, seqs: number[], truncateTo = 0) =>
  encodeAppend({ leader: "a/g1", epoch, truncateTo, entries: seqs.map((s) => entry(s)) });

async function setup() {
  const store = memoryObjectStore();
  const dir = mkdtempSync(join(tmpdir(), "follower-"));
  const follower = createLogFollower({ dir, store, node: "me" });
  return { store, dir, follower };
}

describe("P51 cellb as a follower of celld's log tier", () => {
  it("encodes an append exactly as celld does (CLA1/CLE1)", () => {
    expect(
      encodeAppend({
        leader: "a/g1",
        epoch: 3,
        truncateTo: 0,
        entries: [{ seq: 1, cell: "c", cellEpoch: 1, txid: 5, bytes: Uint8Array.of(0xaa) }],
      }),
    ).toEqual(
      hex(`434c4131 0400 612f6731 0300000000000000 0000000000000000 01000000
           434c4531 0100000000000000 0100 63 0100000000000000 0500000000000000 01000000 aa`),
    );
  });

  it("adopts a leader's epoch only when its node record names this node in an open log", async () => {
    const { store, follower } = await setup();
    // no record yet: refused
    expect(await follower.append(batch(3, [1]))).toEqual({ ok: false, end: 0, epoch: 0 });
    await leaderRecord(store, { epoch: 3, ensemble: ["someone-else"] });
    expect((await follower.append(batch(3, [1]))).ok).toBe(false);
    await leaderRecord(store, { epoch: 3 });
    expect(await follower.append(batch(3, [1]))).toEqual({ ok: true, end: 1, epoch: 3 });
    // the generation must match the record's
    const other = encodeAppend({ leader: "a/g2", epoch: 3, truncateTo: 0, entries: [entry(1)] });
    expect((await follower.append(other)).ok).toBe(false);
  });

  it("accepts entries strictly in sequence; duplicates are confirmed, gaps refused", async () => {
    const { store, follower } = await setup();
    await leaderRecord(store, { epoch: 1 });
    expect(await follower.append(batch(1, [1, 2]))).toEqual({ ok: true, end: 2, epoch: 1 });
    expect(await follower.append(batch(1, [1, 2]))).toEqual({ ok: true, end: 2, epoch: 1 }); // hedged copy
    expect(await follower.append(batch(1, [4]))).toEqual({ ok: false, end: 2, epoch: 1 }); // a gap
    expect(await follower.append(batch(1, [2, 3]))).toEqual({ ok: true, end: 3, epoch: 1 }); // overlap
    // an empty append at the current epoch is the leader's probe
    expect(await follower.append(batch(1, []))).toEqual({ ok: true, end: 3, epoch: 1 });
  });

  it("a seal fences the epoch for good and reports the held range; the tail returns it (CLT2)", async () => {
    const { store, follower, dir } = await setup();
    await leaderRecord(store, { epoch: 2 });
    await follower.append(batch(2, [1, 2, 3]));
    expect(await follower.seal({ leader: "a/g1", epoch: 2 })).toEqual({
      end: 3,
      base: 0,
      fragment_epoch: 2,
      held_fragment_epoch: 2,
    });
    expect((await follower.append(batch(2, [4]))).ok).toBe(false);
    const tail = decodeTail(await follower.tail({ leader: "a/g1", tail_format: 2 }));
    expect(tail).toMatchObject({ fragmentEpoch: 2, base: 0, end: 3, complete: true });
    expect(tail.entries.map((e) => [e.seq, new TextDecoder().decode(e.bytes)])).toEqual([
      [1, "ltx-1"],
      [2, "ltx-2"],
      [3, "ltx-3"],
    ]);
    // everything survives a restart: the fence, the range and the bytes
    const again = createLogFollower({ dir, store, node: "me" });
    expect((await again.append(batch(2, [4]))).ok).toBe(false);
    expect(decodeTail(await again.tail({ leader: "a/g1", tail_format: 2 })).entries).toHaveLength(
      3,
    );
  });

  it("truncate_to drops what the bucket holds; the tail starts after it", async () => {
    const { store, follower } = await setup();
    await leaderRecord(store, { epoch: 1 });
    await follower.append(batch(1, [1, 2, 3]));
    await follower.append(batch(1, [4], 2));
    const tail = decodeTail(await follower.tail({ leader: "a/g1", tail_format: 2 }));
    expect(tail).toMatchObject({ base: 2, end: 4, complete: true });
    expect(tail.entries.map((e) => e.seq)).toEqual([3, 4]);
  });

  it("a new epoch starts over at seq 1, and an unknown leader's seal fences it too", async () => {
    const { store, follower } = await setup();
    await leaderRecord(store, { epoch: 1 });
    await follower.append(batch(1, [1, 2]));
    await leaderRecord(store, { epoch: 2 });
    expect((await follower.append(batch(2, [2]))).ok).toBe(false); // must start at 1
    expect(await follower.append(batch(2, [1]))).toEqual({ ok: true, end: 1, epoch: 2 });
    const fresh = (await setup()).follower;
    expect(await fresh.seal({ leader: "z/g9", epoch: 5 })).toEqual({
      end: 0,
      base: 0,
      fragment_epoch: 0,
      held_fragment_epoch: 0,
    });
  });

  it("keeps a dead leader's fragment until its record closes it, then drops it", async () => {
    const { store, follower } = await setup();
    await leaderRecord(store, { epoch: 1 });
    await follower.append(batch(1, [1, 2]));
    await follower.gc();
    expect(
      decodeTail(await follower.tail({ leader: "a/g1", tail_format: 2 })).entries,
    ).toHaveLength(2);
    await leaderRecord(store, { epoch: 1, state: "sealed" }); // recovered
    await follower.gc();
    const tail = decodeTail(await follower.tail({ leader: "a/g1", tail_format: 2 }));
    expect(tail).toMatchObject({ base: 2, end: 2, entries: [] });
  });
});

describe("P51 the follower over celld's peer protocol", () => {
  it("serves /peer/log/append, /seal and /tail to signed requests only", async () => {
    const { createCellRuntime } = await import("../src/index.js");
    const { startCelldPeerServer, nodeSqliteOpener } = await import("../src/node.js");
    const { loadPeerKey, signPeerRequest } = await import("../src/peer/celld-peer.js");
    const { store, follower } = await setup();
    await leaderRecord(store, { epoch: 1 });
    const runtime = createCellRuntime({ worker: { default: {} }, openSql: nodeSqliteOpener() });
    const server = await startCelldPeerServer({ runtime, store, node: "me", follower });
    const plain = await startCelldPeerServer({ runtime, store, node: "me" });
    const key = await loadPeerKey(store);
    const post = (addr: string, path: string, body: Uint8Array, signed = true) =>
      fetch(`http://${addr}${path}`, {
        method: "POST",
        headers: signed ? signPeerRequest(key, "a", "me", "POST", path, body) : {},
        body: body as BodyInit,
      });
    try {
      const append = batch(1, [1, 2]);
      expect((await post(server.addr, "/peer/log/append", append, false)).status).toBe(401);
      const r = await post(server.addr, "/peer/log/append", append);
      expect(r.status).toBe(200);
      expect(r.headers.get("x-cells-peer-version")).toBe("5");
      expect(await r.json()).toEqual({ ok: true, end: 2, epoch: 1 });
      const seal = await post(
        server.addr,
        "/peer/log/seal",
        enc.encode('{"leader":"a/g1","epoch":1}'),
      );
      expect(await seal.json()).toEqual({
        end: 2,
        base: 0,
        fragment_epoch: 1,
        held_fragment_epoch: 1,
      });
      const tail = await post(
        server.addr,
        "/peer/log/tail",
        enc.encode('{"leader":"a/g1","tail_format":2}'),
      );
      expect(decodeTail(new Uint8Array(await tail.arrayBuffer())).entries).toHaveLength(2);
      // a malformed frame is an error of the request (400), not "cannot serve" (404)
      expect((await post(server.addr, "/peer/log/append", enc.encode("nope"))).status).toBe(400);
      // without a follower the routes stay unserved, as before: celld then quarantines the node
      expect((await post(plain.addr, "/peer/log/append", append)).status).toBe(404);
    } finally {
      await server.close();
      await plain.close();
      await runtime.close();
    }
  });
});
