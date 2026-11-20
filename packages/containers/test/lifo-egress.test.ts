// Lifo reaches the network through its realm's fetch (npm, curl, a guest's fetch). A Lifo container
// has no egress unless its engine allows it and the container asks for it (enableInternet), as
// Wasmer containers. Needs the npm registry for the allowed case.
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPool, type IsolatedPool } from "../src/isolated-pool.ts";

const probe = [
  "node",
  "-e",
  "fetch('https://registry.npmjs.org/ms').then((r) => console.log('reached', r.status), (e) => console.log('blocked', e.message))",
];
const pools: IsolatedPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});
function pool(egress: "none" | "host" | undefined, enableInternet: boolean) {
  const p = createIsolatedPool({
    spawn: () =>
      new Worker(new URL("./fixtures/isolated-lifo-worker.ts", import.meta.url), {
        workerData: { egress },
      }),
    image: { packages: [], enableInternet },
    size: 1,
  });
  pools.push(p);
  return p;
}

describe("Lifo egress", () => {
  it("a container has no network by default", async () => {
    const r = await pool(undefined, false).run({ argv: probe, timeoutMs: 30_000 });
    expect(r.stdout).toMatch(/^blocked .*no egress/);
  });

  it("npm install fails without egress, and works with it", async () => {
    const install = ["npm", "install", "ms@2.1.3"];
    const off = await pool(undefined, false).run({ argv: install, timeoutMs: 60_000 });
    // Lifo's npm warns and exits 0 when a package cannot be fetched: check what it added
    expect(off.stderr).toMatch(/could not install ms: .*no egress/);
    expect(off.stdout).toMatch(/added 0 packages/);
    const on = await pool("host", true).run({ argv: install, timeoutMs: 60_000 });
    expect(on.exitCode, on.stderr).toBe(0);
    expect(on.stdout).toMatch(/added 1 package/);
  });

  it("an engine without egress refuses enableInternet", async () => {
    const r = await pool("none", true)
      .run({ argv: probe, timeoutMs: 30_000 })
      .catch((e: Error) => e);
    expect(String(r)).toMatch(/enableInternet/);
  });

  it("with egress 'host', a container that asks for it reaches the network", async () => {
    const r = await pool("host", true).run({ argv: probe, timeoutMs: 30_000 });
    expect(r.stdout).toBe("reached 200\n");
  });

  it("with egress 'host', a container that does not ask has none", async () => {
    const r = await pool("host", false).run({ argv: probe, timeoutMs: 30_000 });
    expect(r.stdout).toMatch(/^blocked/);
  });
});
