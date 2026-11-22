import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { s3ObjectStore } from "../src/index.js";
import { freePorts } from "../test/free-port.js";

// A hybrid cluster (statewalker/cellb.dev#208): celld fleet nodes and `cellb serve` nodes on ONE
// bucket of a local RustFS, under concurrent load through every node. They must behave as one
// cluster: a counter answers each value once (no two writers, no lost acknowledged write), every
// cell has one owner, a request reaches the owner from any node, and a node that dies or leaves
// hands its cells over. Needs CELLD_BIN, ESBUILD_DIR and the run's RustFS (test/test-bucket.ts).
const CELLD = process.env.CELLD_BIN;
const ENDPOINT = process.env.RUSTFS_ENDPOINT ?? "";
const BUCKET = process.env.TEST_BUCKET ?? "";
const KEYS = { accessKeyId: "rustfsadmin", secretAccessKey: "rustfssecret" };
const env = {
  ...process.env,
  PATH: `${process.env.ESBUILD_DIR ?? ""}:${process.env.PATH}`,
  AWS_ACCESS_KEY_ID: KEYS.accessKeyId,
  AWS_SECRET_ACCESS_KEY: KEYS.secretAccessKey,
  AWS_REGION: "us-east-1",
};
const CLI = resolve(__dirname, "../test/cellb-cli.mjs");
const examples = resolve(__dirname, "../conformance/celld-examples");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Node = {
  kind: "celld" | "cellb";
  name: string;
  p: ChildProcess;
  base: string;
  log: () => string;
  dead?: boolean;
};

async function spawnNode(
  kind: Node["kind"],
  name: string,
  cmd: string,
  args: string[],
  ready: RegExp,
  base: string,
): Promise<Node> {
  const p = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  p.stdout!.on("data", (d) => (log += d));
  p.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 300 && !ready.test(log) && p.exitCode === null; i++) await sleep(100);
  if (!ready.test(log)) {
    p.kill("SIGKILL");
    throw new Error(`${name} did not start:\n${log.slice(-2000)}`);
  }
  return { kind, name, p, base, log: () => log };
}

function run(cmd: string[], cwd: string): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(CELLD!, cmd, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout!.on("data", (d) => (out += d));
    p.stderr!.on("data", (d) => (out += d));
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(out.slice(-1500)))));
  });
}

const stop = (p: ChildProcess, signal: NodeJS.Signals = "SIGTERM") =>
  new Promise<void>((r) => {
    if (p.exitCode !== null || p.signalCode !== null) return r();
    p.once("exit", () => r());
    p.kill(signal);
  });

async function fleet(prefix: string, counts: { celld: number; cellb: number }) {
  const dir = join(mkdtempSync(join(tmpdir(), "hybrid-")), "counter");
  cpSync(join(examples, "counter"), dir, { recursive: true });
  const bucket = `s3://${BUCKET}/${prefix}`;
  await run(["deploy", ".", "--bucket", bucket, "--endpoint", ENDPOINT], dir);
  const nodes: Node[] = [];
  for (let i = 0; i < counts.celld; i++) {
    const [at, internal] = await freePorts(2);
    nodes.push(
      await spawnNode(
        "celld",
        `celld-${i}`,
        CELLD!,
        [
          "--bucket",
          bucket,
          "--endpoint",
          ENDPOINT,
          "--listen",
          `127.0.0.1:${at}`,
          "--internal-listen",
          `127.0.0.1:${internal}`,
        ],
        /readiness is open/,
        `http://127.0.0.1:${at}`,
      ),
    );
  }
  for (let i = 0; i < counts.cellb; i++) {
    const [at] = await freePorts(1);
    const name = `cellb-${prefix}-${i}`;
    nodes.push(
      await spawnNode(
        "cellb",
        name,
        process.execPath,
        [
          "--no-warnings",
          CLI,
          "serve",
          dir,
          "--bucket",
          bucket,
          "--endpoint",
          ENDPOINT,
          "--listen",
          `127.0.0.1:${at}`,
          "--node",
          name,
        ],
        / ready http/,
        `http://127.0.0.1:${at}`,
      ),
    );
  }
  const store = s3ObjectStore({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    prefix,
    region: "us-east-1",
    ...KEYS,
  });
  return {
    nodes,
    store,
    close: () => Promise.all(nodes.map((n) => stop(n.p))),
  };
}

/**
 * Increments `names` counters from `clients` concurrent clients, each request to a random live
 * node, until `until()` says stop. Returns every acknowledged value per counter and the errors.
 */
async function load(nodes: Node[], o: { names: number; clients: number; until: () => boolean }) {
  const acks = new Map<string, number[]>();
  const errors = new Map<string, number>();
  await Promise.all(
    Array.from({ length: o.clients }, async () => {
      while (!o.until()) {
        const name = `k${Math.floor(Math.random() * o.names)}`;
        const live = nodes.filter((n) => !n.dead);
        const node = live[Math.floor(Math.random() * live.length)];
        try {
          const r = await fetch(`${node.base}/increment?name=${name}`, {
            signal: AbortSignal.timeout(30_000),
          });
          const text = await r.text();
          if (r.status !== 200) throw new Error(`${r.status} ${text.slice(0, 160)}`);
          const list = acks.get(name) ?? [];
          list.push(JSON.parse(text).n);
          acks.set(name, list);
        } catch (e) {
          const k = `${node.kind}: ${String((e as Error).message)
            .replace(/[0-9a-f]{64}/g, "<id>")
            .slice(0, 160)}`;
          errors.set(k, (errors.get(k) ?? 0) + 1);
        }
      }
    }),
  );
  return { acks, errors };
}

/** Every acknowledged value of a counter is distinct, and the next increment comes after all. */
async function checkCounters(nodes: Node[], acks: Map<string, number[]>) {
  const problems: string[] = [];
  for (const [name, ns] of acks) {
    const dupes = ns.filter((n, i) => ns.indexOf(n) !== i);
    if (dupes.length)
      problems.push(`${name}: values acknowledged twice: ${[...new Set(dupes)].slice(0, 5)}`);
    let next: number | undefined;
    for (let i = 0; i < 60 && next === undefined; i++) {
      const live = nodes.filter((n) => !n.dead);
      const r = await fetch(`${live[i % live.length].base}/increment?name=${name}`).catch(
        () => undefined,
      );
      if (r?.status === 200) next = JSON.parse(await r.text()).n;
      else await sleep(500);
    }
    if (next === undefined) problems.push(`${name}: unreachable after the load`);
    else if (next <= Math.max(...ns))
      problems.push(`${name}: next value ${next} after acknowledged ${Math.max(...ns)}`);
  }
  return problems;
}

async function owners(store: ReturnType<typeof s3ObjectStore>) {
  const out: Record<string, string> = {};
  for (const k of (await store.list("cells/")).filter((k) => k.endsWith("/own.json")))
    out[k] = JSON.parse(new TextDecoder().decode((await store.get(k))!.body)).node;
  return out;
}

const allowedDuringFailover = (errors: Map<string, number>) =>
  [...errors.keys()].filter(
    (k) =>
      !/owner is currently unreachable|fetch failed|socket hang up|ECONNRESET|other side closed/.test(
        k,
      ),
  );

describe.skipIf(!CELLD || !BUCKET)(
  "P11k a hybrid celld + cellb cluster on one RustFS bucket",
  { concurrent: true },
  () => {
    it("serves concurrent load through every node as one cluster: one owner per cell, no lost or repeated value", async () => {
      const f = await fleet(`k${Date.now().toString(36)}a`, { celld: 2, cellb: 2 });
      try {
        let left = 1_500;
        const { acks, errors } = await load(f.nodes, {
          names: 20,
          clients: 16,
          until: () => left-- <= 0,
        });
        expect(Object.fromEntries(errors)).toEqual({});
        expect(await checkCounters(f.nodes, acks)).toEqual([]);
        const own = await owners(f.store);
        expect(Object.keys(own)).toHaveLength(20);
        const names = new Set([...f.nodes.map((n) => n.name)]);
        const cellbOwned = Object.values(own).filter((n) => names.has(n)).length;
        expect(cellbOwned, JSON.stringify(own)).toBeGreaterThan(0); // cellb nodes own some cells
        expect(cellbOwned).toBeLessThan(20); // and celld nodes the others
      } finally {
        await f.close();
      }
    }, 240_000);

    for (const victim of ["cellb", "celld"] as const) {
      it(`loses no acknowledged write when a ${victim} node is killed under load; its cells move`, async () => {
        const f = await fleet(`k${Date.now().toString(36)}${victim[3]}`, { celld: 2, cellb: 2 });
        try {
          const t0 = Date.now();
          const killer = (async () => {
            await sleep(2_500);
            const n = f.nodes.find((x) => x.kind === victim)!;
            n.dead = true;
            n.p.kill("SIGKILL");
          })();
          // past the dead node's lease (10 s) and its cells' recovery
          const { acks, errors } = await load(f.nodes, {
            names: 20,
            clients: 16,
            until: () => Date.now() - t0 > 18_000,
          });
          await killer;
          expect(allowedDuringFailover(errors)).toEqual([]);
          expect(await checkCounters(f.nodes, acks)).toEqual([]);
          const dead = f.nodes.find((x) => x.dead)!.name;
          const own = await owners(f.store);
          // celld names its nodes node_<hex>: a dead celld node owns nothing that was used since
          if (victim === "cellb") expect(Object.values(own)).not.toContain(dead);
        } finally {
          await f.close();
        }
      }, 300_000);
    }

    it("a cellb node that leaves (SIGTERM) under load hands its cells over at once", async () => {
      const f = await fleet(`k${Date.now().toString(36)}t`, { celld: 1, cellb: 2 });
      try {
        const t0 = Date.now();
        const leaver = (async () => {
          await sleep(2_000);
          const n = f.nodes.find((x) => x.kind === "cellb")!;
          n.dead = true;
          await stop(n.p, "SIGTERM");
          return Date.now() - t0;
        })();
        const { acks, errors } = await load(f.nodes, {
          names: 20,
          clients: 16,
          until: () => Date.now() - t0 > 6_000,
        });
        await leaver;
        // A graceful leave drains: requests in flight at the leaving node finish, and its cells
        // are released, so the other nodes take them at once (no lease to wait for).
        expect(Object.fromEntries(errors)).toEqual({});
        expect(await checkCounters(f.nodes, acks)).toEqual([]);
      } finally {
        await f.close();
      }
    }, 240_000);
  },
);
