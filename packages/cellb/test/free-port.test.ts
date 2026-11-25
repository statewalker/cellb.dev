// The free-port helper (statewalker/cellb.dev#228, #248's interop run): tests that run at once in
// one process each ask for ports, and a port handed out once must not be handed out again, or two
// servers race to bind it ("Address already in use"). Random picks from 12 768 ports collide within
// a few hundred calls (the birthday bound), so 400 calls find a repeat almost surely without the
// reservation.
import { describe, expect, test } from "vitest";
import { freePort, freePorts } from "./free-port.js";

describe("freePorts", () => {
  test("never hands out a port twice in one process", async () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) for (const p of await freePorts(2)) seen.add(p);
    expect(seen.size).toBe(400);
  });

  test("concurrent callers get distinct ports", async () => {
    const ports = await Promise.all(Array.from({ length: 50 }, () => freePort()));
    expect(new Set(ports).size).toBe(50);
  });
});
