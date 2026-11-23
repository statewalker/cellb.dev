import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { s3ObjectStore } from "../src/index.js";
import { freePorts } from "../test/free-port.js";

// celld's log tier (CELLD_DURABILITY=fleet, the default) copies each commit's LTX segments to
// follower nodes and acknowledges once they hold them on disk, before the bucket does. A celld
// node recruits followers among every live node record, a cellb node included
// (statewalker/cellb.dev#208): cellb must serve the follower side (`/peer/log/*`), or celld
// quarantines it and its acknowledgements fall back to the bucket. And what a cellb follower
// holds must bring back the acknowledged writes of a celld leader that died.
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
  CELLB_DEBUG_FOLLOWER: "1",
};
const CLI = resolve(__dirname, "../test/cellb-cli.mjs");
const examples = resolve(__dirname, "../conformance/celld-examples");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dec = new TextDecoder();

type Proc = { p: ChildProcess; base: string; log: () => string };

async function spawnNode(cmd: string, args: string[], ready: RegExp, base: string): Promise<Proc> {
  const p = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  p.stdout!.on("data", (d) => (log += d));
  p.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 300 && !ready.test(log) && p.exitCode === null; i++) await sleep(100);
  if (!ready.test(log)) {
    p.kill("SIGKILL");
    throw new Error(
      `node did not start (${args.slice(0, 3).join(" ")} … exit ${p.exitCode}):\n${log.slice(-2500)}`,
    );
  }
  return { p, base, log: () => log };
}
const stop = (p: ChildProcess, signal: NodeJS.Signals = "SIGTERM") =>
  new Promise<void>((r) => {
    if (p.exitCode !== null || p.signalCode !== null) return r();
    p.once("exit", () => r());
    p.kill(signal);
  });

async function setup(prefix: string) {
  const dir = join(mkdtempSync(join(tmpdir(), "follower-")), "counter");
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
  const celld = async () => {
    const [at, internal] = await freePorts(2);
    return spawnNode(
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
  };
  const cellb = async (name: string) => {
    const [at] = await freePorts(1);
    const n = await spawnNode(
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
    );
    // a node record, live: the cellb node takes a cell of its own
    await (await fetch(`${n.base}/increment?name=cellb-own-${name}`)).text();
    return n;
  };
  const records = async () => {
    const out: Record<string, { log?: { state: string; ensemble: string[]; active: boolean } }> =
      {};
    for (const k of await store.list("nodes/"))
      out[k.slice(6, -5)] = JSON.parse(dec.decode((await store.get(k))!.body));
    return out;
  };
  return { celld, cellb, records };
}

const complaints = (log: string) =>
  log
    .split("\n")
    .filter((l) => /cannot serve log appends|acks ride the bucket|no peer is eligible/.test(l))
    .map((l) => l.replace(/^\S+\s+/, "").slice(0, 200));

async function increments(base: string, names: string[], ms: number) {
  const acked = new Map<string, number>();
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (Date.now() - t0 < ms) {
        const name = names[Math.floor(Math.random() * names.length)];
        const r = await fetch(`${base}/increment?name=${name}`).catch(() => undefined);
        if (r?.status === 200) {
          const n = JSON.parse(await r.text()).n;
          acked.set(name, Math.max(acked.get(name) ?? 0, n));
        }
      }
    }),
  );
  return acked;
}

describe.skipIf(!CELLD || !BUCKET)(
  "P11m cellb as a follower in celld's log tier",
  { concurrent: true },
  () => {
    it("celld recruits a cellb node as a follower and keeps acknowledging on it", async () => {
      const f = await setup(`m${Date.now().toString(36)}a`);
      const nodes: Proc[] = [];
      try {
        nodes.push(await f.cellb("cellb-f0"), await f.celld(), await f.celld());
        // past celld's log maintenance tick (30 s), with writes on the celld nodes
        await Promise.all(
          [nodes[1], nodes[2]].map((n) =>
            increments(
              n.base,
              Array.from({ length: 10 }, (_, i) => `k${i}`),
              40_000,
            ),
          ),
        );
        if ([...complaints(nodes[1].log()), ...complaints(nodes[2].log())].length)
          for (const n of nodes)
            console.error(
              "DEBUG228",
              n.log()
                .split("\n")
                .filter((l) => /evict|append|follower|degrad|quarantin|cellb-f0|WARN|ERROR|DBGF/i.test(l))
                .slice(-60)
                .join("\n"),
            );
        expect([...complaints(nodes[1].log()), ...complaints(nodes[2].log())]).toEqual([]);
        const recs = await f.records();
        const ensembles = Object.values(recs).flatMap((r) => r.log?.ensemble ?? []);
        expect(ensembles, JSON.stringify(recs)).toContain("cellb-f0");
      } finally {
        await Promise.all(nodes.map((n) => stop(n.p)));
      }
    }, 240_000);

    it("a celld leader whose only follower is a cellb node dies: a new celld node recovers every acknowledged write from it", async () => {
      const f = await setup(`m${Date.now().toString(36)}b`);
      const nodes: Proc[] = [];
      try {
        nodes.push(await f.cellb("cellb-f1"));
        const leader = await f.celld();
        nodes.push(leader);
        const names = Array.from({ length: 10 }, (_, i) => `k${i}`);
        // the leader's ensemble forms with the cellb node, then writes acknowledged on it
        let recs = await f.records();
        for (let i = 0; i < 90 && !Object.values(recs).some((r) => r.log?.active); i++) {
          await increments(leader.base, names, 1_000);
          recs = await f.records();
        }
        expect(complaints(leader.log())).toEqual([]);
        const acked = await increments(leader.base, names, 5_000);
        leader.p.kill("SIGKILL");
        // a new celld node recovers the dead leader's log (seal + tail on the cellb follower)
        const next = await f.celld();
        nodes.push(next);
        const after: Record<string, number> = {};
        for (const name of names) {
          for (let i = 0; i < 120 && after[name] === undefined; i++) {
            const r = await fetch(`${next.base}/increment?name=${name}`).catch(() => undefined);
            if (r?.status === 200) after[name] = JSON.parse(await r.text()).n;
            else await sleep(1_000);
          }
        }
        const lost = names.filter((n) => acked.has(n) && !(after[n] > acked.get(n)!));
        expect(lost, JSON.stringify({ acked: Object.fromEntries(acked), after })).toEqual([]);
      } finally {
        await Promise.all(nodes.map((n) => stop(n.p, "SIGKILL")));
      }
    }, 300_000);
  },
);
