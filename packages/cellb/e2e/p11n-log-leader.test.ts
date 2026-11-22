import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { s3ObjectStore } from "../src/index.js";
import { freePorts } from "../test/free-port.js";
import { slowS3Proxy } from "../test/slow-s3-proxy.js";

// cellb as a LEADER in celld's log tier (statewalker/cellb.dev#209): a `cellb serve` node's
// commits are acknowledged once its followers — celld or cellb nodes — hold them; celld follows it
// without complaint; and when the cellb leader dies, its acknowledged writes come back through the
// recovery of its session, by celld or by another cellb node.
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
const dec = new TextDecoder();

type Proc = { p: ChildProcess; base: string; name: string; log: () => string };

async function spawnNode(name: string, cmd: string, args: string[], ready: RegExp, base: string) {
  const p = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  p.stdout!.on("data", (d) => (log += d));
  p.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 300 && !ready.test(log) && p.exitCode === null; i++) await sleep(100);
  if (!ready.test(log)) {
    p.kill("SIGKILL");
    throw new Error(`${name} did not start:\n${log.slice(-2000)}`);
  }
  return { p, base, name, log: () => log } as Proc;
}
const stop = (p: ChildProcess, signal: NodeJS.Signals = "SIGTERM") =>
  new Promise<void>((r) => {
    if (p.exitCode !== null || p.signalCode !== null) return r();
    p.once("exit", () => r());
    p.kill(signal);
  });

async function fleet(prefix: string) {
  const dir = join(mkdtempSync(join(tmpdir(), "leader-")), "counter");
  cpSync(join(examples, "counter"), dir, { recursive: true });
  const bucket = `s3://${BUCKET}/${prefix}`;
  await new Promise<void>((res, rej) => {
    const p = spawn(CELLD!, ["deploy", ".", "--bucket", bucket, "--endpoint", ENDPOINT], {
      cwd: dir,
      env,
      stdio: "ignore",
    });
    p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`deploy: ${c}`))));
  });
  const store = s3ObjectStore({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    prefix,
    region: "us-east-1",
    ...KEYS,
  });
  let celldNo = 0;
  return {
    store,
    celld: async () => {
      const [at, internal] = await freePorts(2);
      return spawnNode(
        `celld-${celldNo++}`,
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
      );
    },
    cellb: async (name: string, endpoint = ENDPOINT) => {
      const [at] = await freePorts(1);
      return spawnNode(
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
          endpoint,
          "--listen",
          `127.0.0.1:${at}`,
          "--node",
          name,
        ],
        / ready http/,
        `http://127.0.0.1:${at}`,
      );
    },
    record: async (node: string) => {
      const o = await store.get(`nodes/${node}.json`);
      return o ? JSON.parse(dec.decode(o.body)) : undefined;
    },
    /** celld's node name: the one record that is not a cellb node's. */
    celldNode: async () => {
      for (const k of await store.list("nodes/")) if (k.includes("node_")) return k.slice(6, -5);
      return undefined;
    },
  };
}

/** Increments `names` through `base` for `ms`; the highest value acknowledged per counter. */
async function load(base: string, names: string[], ms: number) {
  const acked = new Map<string, number>();
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (Date.now() - t0 < ms) {
        const name = names[Math.floor(Math.random() * names.length)];
        const r = await fetch(`${base}/increment?name=${name}`).catch(() => undefined);
        if (r?.status === 200)
          acked.set(name, Math.max(acked.get(name) ?? 0, JSON.parse(await r.text()).n));
      }
    }),
  );
  return acked;
}

/** Every counter answers after its highest acknowledged value (none lost). */
async function lost(base: string, acked: Map<string, number>) {
  const out: string[] = [];
  for (const [name, n] of acked) {
    let next: number | undefined;
    for (let i = 0; i < 120 && next === undefined; i++) {
      const r = await fetch(`${base}/increment?name=${name}`).catch(() => undefined);
      if (r?.status === 200) next = JSON.parse(await r.text()).n;
      else await sleep(1_000);
    }
    if (!(next !== undefined && next > n)) out.push(`${name}: acknowledged ${n}, then ${next}`);
  }
  return out;
}

const until = async (f: () => Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return true;
    await sleep(500);
  }
  return false;
};

const complaints = (log: string) =>
  log
    .split("\n")
    .filter(
      (l) =>
        /cannot serve log appends|refus|degraded|rejected .*append|adopt/i.test(l) &&
        /WARN|ERROR/.test(l),
    )
    .map((l) => l.replace(/^\S+\s+/, "").slice(0, 200));

describe.skipIf(!CELLD || !BUCKET)(
  "P11n cellb leads a log tier session with celld",
  { concurrent: true },
  () => {
    it("a celld node follows a cellb leader: the session is active with celld in it, and celld does not complain", async () => {
      const f = await fleet(`n${Date.now().toString(36)}a`);
      const nodes: Proc[] = [];
      try {
        nodes.push(await f.celld());
        const lead = await f.cellb("cellb-lead-a");
        nodes.push(lead);
        const celldNode = await f.celldNode();
        expect(
          await until(async () => {
            await load(lead.base, ["a0", "a1", "a2"], 1_000);
            const log = (await f.record("cellb-lead-a"))?.log;
            return !!log && log.active && log.ensemble.includes(celldNode);
          }, 60_000),
          JSON.stringify((await f.record("cellb-lead-a"))?.log),
        ).toBe(true);
        expect(complaints(nodes[0].log())).toEqual([]);
      } finally {
        await Promise.all(nodes.map((n) => stop(n.p)));
      }
    }, 180_000);

    it("a cellb leader whose only follower is celld dies: celld recovers its session, no acknowledged write is lost", async () => {
      const f = await fleet(`n${Date.now().toString(36)}b`);
      const nodes: Proc[] = [];
      const closers: (() => Promise<void>)[] = [];
      try {
        const celld = await f.celld();
        nodes.push(celld);
        // the leader's bucket is slow: its followers acknowledge its commits first, so at its
        // death acknowledged writes are on its followers and not yet in the bucket
        const slow = await slowS3Proxy(ENDPOINT, 1_500);
        closers.push(slow.close);
        const lead = await f.cellb("cellb-lead-b", slow.endpoint);
        nodes.push(lead);
        const names = Array.from({ length: 10 }, (_, i) => `b${i}`);
        // the session forms and acknowledges on celld
        expect(
          await until(async () => {
            await load(lead.base, names, 1_000);
            return !!(await f.record("cellb-lead-b"))?.log?.active;
          }, 60_000),
        ).toBe(true);
        const acked = await load(lead.base, names, 4_000);
        lead.p.kill("SIGKILL");
        const segments = async () =>
          (await f.store.list("cells/")).filter((k) => k.endsWith(".ltx")).length;
        const atKill = await segments();
        // celld's sweep recovers the dead session once its record has expired
        expect(
          await until(
            async () => (await f.record("cellb-lead-b"))?.log?.state === "sealed",
            120_000,
          ),
          JSON.stringify((await f.record("cellb-lead-b"))?.log),
        ).toBe(true);
        // the recovery brought back what only the followers held
        expect(await segments()).toBeGreaterThan(atKill);
        expect(await lost(celld.base, acked)).toEqual([]);
      } finally {
        await Promise.all(nodes.map((n) => stop(n.p, "SIGKILL")));
        for (const c of closers) await c();
      }
    }, 300_000);

    it("in a fleet of cellb nodes, a dead leader's session is recovered by another cellb node", async () => {
      const f = await fleet(`n${Date.now().toString(36)}c`);
      const nodes: Proc[] = [];
      const closers: (() => Promise<void>)[] = [];
      try {
        const other = await f.cellb("cellb-other-c");
        nodes.push(other);
        // a live record for the other node: it takes a cell of its own
        await (await fetch(`${other.base}/increment?name=own`)).text();
        // the leader's bucket is slow: its followers acknowledge its commits first, so at its
        // death acknowledged writes are on its followers and not yet in the bucket
        const slow = await slowS3Proxy(ENDPOINT, 1_500);
        closers.push(slow.close);
        const lead = await f.cellb("cellb-lead-c", slow.endpoint);
        nodes.push(lead);
        const names = Array.from({ length: 10 }, (_, i) => `c${i}`);
        expect(
          await until(async () => {
            await load(lead.base, names, 1_000);
            const log = (await f.record("cellb-lead-c"))?.log;
            return !!log?.active && log.ensemble.includes("cellb-other-c");
          }, 60_000),
        ).toBe(true);
        const acked = await load(lead.base, names, 4_000);
        lead.p.kill("SIGKILL");
        const segments = async () =>
          (await f.store.list("cells/")).filter((k) => k.endsWith(".ltx")).length;
        const atKill = await segments();
        expect(
          await until(
            async () => (await f.record("cellb-lead-c"))?.log?.state === "sealed",
            120_000,
          ),
          JSON.stringify((await f.record("cellb-lead-c"))?.log),
        ).toBe(true);
        expect(await segments()).toBeGreaterThan(atKill);
        expect(await lost(other.base, acked)).toEqual([]);
      } finally {
        await Promise.all(nodes.map((n) => stop(n.p, "SIGKILL")));
        for (const c of closers) await c();
      }
    }, 300_000);
  },
);
