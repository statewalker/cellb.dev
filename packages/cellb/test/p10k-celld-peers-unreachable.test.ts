import { describe, expect, it } from "vitest";
import { DurableObjectRoutingError, memoryObjectStore } from "../src/index.js";
import { celldPeers } from "../src/node.js";
import { freePort } from "./free-port.js";

// celldPeers reaching an owner whose process is gone while its node lease is still live: celld
// answers "The Durable Object owner is currently unreachable" (DurableObjectRoutingError); cellb
// answered with the socket's own error (statewalker/cellb.dev#208).
describe("P10k celldPeers: an owner that cannot be reached", () => {
  const enc = new TextEncoder();
  async function fleetWithDeadOwner() {
    const store = memoryObjectStore();
    const key = "ab".repeat(32);
    await store.put("fleet/peer-auth.json", enc.encode(JSON.stringify({ version: 1, key })));
    const port = await freePort(); // nobody listens there
    await store.put(
      "nodes/dead.json",
      enc.encode(
        JSON.stringify({
          node: "dead",
          addr: `127.0.0.1:${port}`,
          expires_ms: Date.now() + 60_000,
        }),
      ),
    );
    await store.put(
      "cells/Counter:" + "0".repeat(64) + "/own.json",
      enc.encode('{"node":"dead","epoch":1}'),
    );
    return celldPeers({ store, node: "me" });
  }
  const cellKey = `Counter/${"0".repeat(64)}`;

  it("fetch fails with DurableObjectRoutingError", async () => {
    const peers = await fleetWithDeadOwner();
    expect(await peers.ownerOf(cellKey)).toBe("dead");
    const ep = await peers.endpoint("dead", cellKey, "a");
    const err = await ep!.fetch(new Request("http://w/")).catch((e) => e);
    expect(err).toBeInstanceOf(DurableObjectRoutingError);
    expect(err.message).toBe("The Durable Object owner is currently unreachable");
    expect(String(err.cause)).toMatch(/ECONNREFUSED/);
  });

  it("RPC fails with DurableObjectRoutingError", async () => {
    const peers = await fleetWithDeadOwner();
    const ep = await peers.endpoint("dead", cellKey, "a");
    const err = await ep!.call("inc", []).catch((e) => e);
    expect(err).toBeInstanceOf(DurableObjectRoutingError);
  });

  it("an owner whose node lease expired is not reached either (the cell is about to move)", async () => {
    const store = memoryObjectStore();
    await store.put(
      "nodes/gone.json",
      enc.encode(JSON.stringify({ node: "gone", addr: "127.0.0.1:9", expires_ms: Date.now() - 1 })),
    );
    const peers = celldPeers({ store, node: "me" });
    expect(await peers.endpoint("gone", cellKey, "a")).toBeUndefined();
    expect(() => peers.link()).toThrow(DurableObjectRoutingError);
  });
});
