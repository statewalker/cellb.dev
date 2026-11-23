// Containers move with their cells across a fleet of `cellb serve` nodes on one S3 bucket.
//
// Each node runs the project with a container engine (`--containers serve/<engine>.ts`): a cell's
// container lives on the node that owns the cell. When that node dies (SIGKILL) or leaves
// (SIGTERM), another node takes the cell, starts the same image (the project's
// cellb.containers.Runner) and runs the same job script, and the cell's storage goes on from
// where it was. Run under cellb's scripts/interop-env.sh (RUSTFS_ENDPOINT, a local RustFS):
//
//   ../cellb/scripts/interop-env.sh pnpm vitest run test/fleet-migration.test.ts
//   ENGINES=lifo,wasmer BENCH_JSON=bench/results/fleet-migration.json …   (Wasmer: the registry)
import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { s3ObjectStore } from "@statewalker/cellb";
import { describe, expect, it } from "vitest";

const ENDPOINT = process.env.RUSTFS_ENDPOINT ?? "";
const ENGINES = (process.env.ENGINES ?? "lifo").split(",");
const KEYS = { accessKeyId: "rustfsadmin", secretAccessKey: "rustfssecret" };
const CLI = fileURLToPath(new URL("../../cellb/test/cellb-cli.mjs", import.meta.url));
const CELLS = Array.from({ length: 6 }, (_, i) => `job-${i}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

type Node = { name: string; p: ChildProcess; base: string; log: () => string; dead?: boolean };
type Run = {
  runs: number;
  startMs: number;
  execMs: number;
  exitCode: number;
  out: string;
  err: string;
};

async function fleet(engine: string, size: number) {
  const prefix = `migrate-${engine}-${Date.now().toString(36)}`;
  const dir = fileURLToPath(new URL(`./fixtures/fleet-runner-${engine}`, import.meta.url));
  const module = fileURLToPath(new URL(`../serve/${engine}.ts`, import.meta.url));
  const nodes: Node[] = [];
  for (let i = 0; i < size; i++) {
    const at = await freePort();
    const name = `${prefix}-n${i}`;
    const p = spawn(
      process.execPath,
      [
        "--no-warnings",
        CLI,
        "serve",
        dir,
        "--bucket",
        `s3://cells/${prefix}`,
        "--endpoint",
        ENDPOINT,
        "--listen",
        `127.0.0.1:${at}`,
        "--node",
        name,
        "--containers",
        module,
      ],
      {
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: KEYS.accessKeyId,
          AWS_SECRET_ACCESS_KEY: KEYS.secretAccessKey,
          AWS_REGION: "us-east-1",
        },
        stdio: ["ignore", "pipe", "pipe"],
        // its own process group: a crash (SIGKILL) takes the node and the process it relaunches
        // itself as (Node 22, for AsyncContextFrame) at once, as a machine going down would
        detached: true,
      },
    );
    let log = "";
    p.stdout!.on("data", (d) => (log += d));
    p.stderr!.on("data", (d) => (log += d));
    for (let t = 0; t < 600 && !/ ready http/.test(log) && p.exitCode === null; t++)
      await sleep(100);
    if (!/ ready http/.test(log)) throw new Error(`${name} did not start:\n${log.slice(-2000)}`);
    expect(log).not.toMatch(/unsupported/);
    nodes.push({ name, p, base: `http://127.0.0.1:${at}`, log: () => log });
  }
  const store = s3ObjectStore({
    endpoint: ENDPOINT,
    bucket: "cells",
    prefix,
    region: "us-east-1",
    ...KEYS,
  });
  const owners = async () => {
    const out: Record<string, string> = {};
    for (const k of (await store.list("cells/")).filter((k) => k.endsWith("/own.json")))
      out[k] = JSON.parse(new TextDecoder().decode((await store.get(k))!.body)).node;
    return out;
  };
  const call = async (cell: string, via?: Node): Promise<Run & { via: string; ms: number }> => {
    const live = nodes.filter((n) => !n.dead);
    const n = via ?? live[Math.floor(Math.random() * live.length)];
    const t = performance.now();
    const r = await fetch(`${n.base}/?cell=${cell}`, { signal: AbortSignal.timeout(120_000) });
    const text = await r.text();
    if (r.status !== 200) throw new Error(`${r.status} ${text.slice(0, 300)}`);
    return { ...(JSON.parse(text) as Run), via: n.name, ms: performance.now() - t };
  };
  const stop = (n: Node, signal: NodeJS.Signals) =>
    new Promise<void>((r) => {
      n.dead = true;
      if (n.p.exitCode !== null || n.p.signalCode !== null) return r();
      n.p.once("exit", () => r());
      if (signal === "SIGKILL") process.kill(-n.p.pid!, signal);
      else n.p.kill(signal);
    });
  return {
    nodes,
    owners,
    call,
    stop,
    close: () => Promise.all(nodes.map((n) => stop(n, "SIGTERM"))),
  };
}

const check = (r: Run, runs: number, engine: string) => {
  expect(r.exitCode, r.err).toBe(0);
  expect(JSON.parse(r.out)).toMatchObject({ run: runs, engine });
  expect(r.runs).toBe(runs);
};
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0);
};

const results: Record<string, unknown> = {};

describe.skipIf(!ENDPOINT)("containers move with their cells across cellb fleet nodes", () => {
  for (const engine of ENGINES) {
    it(`${engine}: a cell's job runs on its owner, and on the next owner after a SIGKILL and a SIGTERM`, async () => {
      const f = await fleet(engine, 3);
      const out: Record<string, unknown> = { engine, nodes: 3, cells: CELLS.length };
      try {
        // Cold: each cell's first call starts its container on the node that claims the cell.
        const cold = await Promise.all(CELLS.map((c) => f.call(c)));
        for (const r of cold) {
          check(r, 1, engine);
          expect(JSON.parse(r.out).fresh).toBe(true);
        }
        // Every cell keeps its owner while all nodes live (a move would leave a container behind).
        const owned0 = await f.owners();
        // Warm: the container is running; a call runs the job only.
        const warm = [];
        for (let round = 2; round <= 4; round++)
          for (const c of CELLS) {
            const r = await f.call(c);
            check(r, round, engine);
            expect(JSON.parse(r.out).fresh).toBe(false); // the same container ran the last job
            warm.push(r);
          }
        expect(await f.owners(), "a cell moved between live nodes").toEqual(owned0);
        out.coldStartMs = {
          p50: pct(
            cold.map((r) => r.startMs),
            0.5,
          ),
          max: pct(
            cold.map((r) => r.startMs),
            1,
          ),
        };
        out.coldCallMs = {
          p50: pct(
            cold.map((r) => r.ms),
            0.5,
          ),
          max: pct(
            cold.map((r) => r.ms),
            1,
          ),
        };
        out.warmExecMs = {
          p50: pct(
            warm.map((r) => r.execMs),
            0.5,
          ),
          p90: pct(
            warm.map((r) => r.execMs),
            0.9,
          ),
        };
        out.warmCallMs = {
          p50: pct(
            warm.map((r) => r.ms),
            0.5,
          ),
          p90: pct(
            warm.map((r) => r.ms),
            0.9,
          ),
        };

        let runs = 4;
        for (const signal of ["SIGKILL", "SIGTERM"] as const) {
          // the node that owns the most cells goes
          const own = Object.values(await f.owners());
          const victim = f.nodes
            .filter((n) => !n.dead)
            .map((n) => ({ n, owned: own.filter((o) => o === n.name).length }))
            .sort((a, b) => b.owned - a.owned)[0];
          expect(victim.owned).toBeGreaterThan(0);
          const t0 = performance.now();
          await f.stop(victim.n, signal);
          runs++;
          // every cell answers again, on a live node, with its count and a new container
          const back = await Promise.all(
            CELLS.map(async (c) => {
              for (;;) {
                try {
                  const r = await f.call(c);
                  return { ...r, afterMs: performance.now() - t0 };
                } catch (e) {
                  if (performance.now() - t0 > 90_000) throw e;
                  await sleep(250);
                }
              }
            }),
          );
          for (const r of back) check(r, runs, engine);
          // a cell whose job ran in a fresh container: it moved, and its new owner started one
          const moved = back.filter((r) => JSON.parse(r.out).fresh);
          expect(moved.length).toBe(victim.owned);
          const after = Object.values(await f.owners());
          expect(after).not.toContain(victim.n.name);
          out[signal] = {
            cellsMoved: moved.length,
            backAfterMs: {
              p50: pct(
                moved.map((r) => r.afterMs),
                0.5,
              ),
              max: pct(
                moved.map((r) => r.afterMs),
                1,
              ),
            },
            newContainerStartMs: {
              p50: pct(
                moved.map((r) => r.startMs),
                0.5,
              ),
              max: pct(
                moved.map((r) => r.startMs),
                1,
              ),
            },
          };
        }
        results[engine] = out;
        console.log(JSON.stringify(out));
      } catch (e) {
        for (const n of f.nodes) console.error(`--- ${n.name}\n${n.log().slice(-3000)}`);
        throw e;
      } finally {
        await f.close();
        if (process.env.BENCH_JSON)
          writeFileSync(
            process.env.BENCH_JSON,
            `${JSON.stringify({ date: new Date().toISOString(), node: process.version, results }, null, 2)}\n`,
          );
      }
    }, 600_000);
  }
});
