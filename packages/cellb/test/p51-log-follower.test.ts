import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

// celld's follower makes one durable write per burst: the batch file, with the follower's state
// in it (node_log.rs handle_append). celld evicts a follower whose append latency stays above
// max(4 x its siblings', 25 ms) for 2 s ("gray follower"), so a follower that fsyncs a segment and
// a state file per append, one append at a time, loses its place on a slow disk.
describe("P51 the follower's appends cost what celld's do", () => {
  const files = (dir: string) => readdirSync(join(dir, "peerlog", "a", "g1"));
  it("appends that arrive together are written together", async () => {
    const { store, follower, dir } = await setup();
    await leaderRecord(store, { epoch: 1 });
    const replies = await Promise.all(
      Array.from({ length: 10 }, (_, i) => follower.append(batch(1, [i + 1]))),
    );
    expect(replies.map((r) => r.ok)).toEqual(Array(10).fill(true));
    expect(replies.at(-1)).toEqual({ ok: true, end: 10, epoch: 1 });
    expect(files(dir).filter((n) => n.startsWith("seg-")).length).toBeLessThanOrEqual(2);
  });

  it("an append in an open epoch writes its segment only, not the state file", async () => {
    const { store, follower, dir } = await setup();
    await leaderRecord(store, { epoch: 1 });
    await follower.append(batch(1, [1]));
    const state = readFileSync(join(dir, "peerlog", "a", "g1", "state.json"), "utf8");
    await follower.append(batch(1, [2, 3]));
    await follower.append(batch(1, [4], 2));
    expect(readFileSync(join(dir, "peerlog", "a", "g1", "state.json"), "utf8")).toBe(state);
  });

  it("a restart finds the range and the base in the segments", async () => {
    const { store, follower, dir } = await setup();
    await leaderRecord(store, { epoch: 1 });
    await follower.append(batch(1, [1, 2, 3]));
    await follower.append(batch(1, [4, 5], 2));
    const again = createLogFollower({ dir, store, node: "me" });
    const tail = decodeTail(await again.tail({ leader: "a/g1", tail_format: 2 }));
    expect(tail).toMatchObject({ fragmentEpoch: 1, base: 2, end: 5, complete: true });
    expect(tail.entries.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(await again.append(batch(1, [6]))).toEqual({ ok: true, end: 6, epoch: 1 });
  });

  it("a torn segment that was never acknowledged is dropped on restart", async () => {
    const { store, follower, dir } = await setup();
    await leaderRecord(store, { epoch: 1 });
    await follower.append(batch(1, [1, 2]));
    writeFileSync(join(dir, "peerlog", "a", "g1", "seg-1-3-4.bin"), Uint8Array.of(1, 2, 3));
    const again = createLogFollower({ dir, store, node: "me" });
    const tail = decodeTail(await again.tail({ leader: "a/g1", tail_format: 2 }));
    expect(tail).toMatchObject({ base: 0, end: 2, complete: true });
    expect(await again.append(batch(1, [3]))).toEqual({ ok: true, end: 3, epoch: 1 });
  });

  it("reads the segments an earlier cellb wrote (no header, the range in state.json)", async () => {
    const { store, dir } = await setup();
    await leaderRecord(store, { epoch: 1 });
    const d = join(dir, "peerlog", "a", "g1");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(d, { recursive: true });
    // the CLE1 frames of an append, as 0.12.0 wrote them into a segment file
    const frames = (seqs: number[]) => batch(1, seqs).subarray(4 + 2 + 4 + 8 + 8 + 4);
    writeFileSync(join(d, "seg-1-1-2.bin"), frames([1, 2]));
    writeFileSync(join(d, "seg-1-3-3.bin"), frames([3]));
    writeFileSync(join(d, "state.json"), '{"fragmentEpoch":1,"base":1,"end":3,"sealedTo":0}');
    const f = createLogFollower({ dir, store, node: "me" });
    const tail = decodeTail(await f.tail({ leader: "a/g1", tail_format: 2 }));
    expect(tail).toMatchObject({ base: 1, end: 3, complete: true });
    expect(tail.entries.map((e) => e.seq)).toEqual([2, 3]);
    expect(await f.append(batch(1, [4]))).toEqual({ ok: true, end: 4, epoch: 1 });
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
