import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { wasmMemoryOpener } from "../src/adapters/wasm-sqlite.js";
import { celldBucket } from "../src/bucket/celld-cells.js";
import { s3ObjectStore } from "../src/bucket/s3-object-store.js";
import { loadNodeProject } from "../src/project/node-project.js";

// A real celld fleet node and webrun-cells on ONE S3 bucket served by a local RustFS: cells
// move between them through celld's ownership protocol (own.json epochs, node leases), and
// alarms through celld's wake index. Needs CELLD_BIN, ESBUILD_DIR and a running RustFS
// (RUSTFS_ENDPOINT, default http://127.0.0.1:9100, keys rustfsadmin / rustfssecret).
const CELLD = process.env.CELLD_BIN;
const ENDPOINT = process.env.RUSTFS_ENDPOINT ?? "http://127.0.0.1:9100";
const KEYS = {
  accessKeyId: process.env.RUSTFS_ACCESS_KEY ?? "rustfsadmin",
  secretAccessKey: process.env.RUSTFS_SECRET_KEY ?? "rustfssecret",
};
const env = {
  ...process.env,
  PATH: `${process.env.ESBUILD_DIR ?? ""}:${process.env.PATH}`,
  AWS_ACCESS_KEY_ID: KEYS.accessKeyId,
  AWS_SECRET_ACCESS_KEY: KEYS.secretAccessKey,
  AWS_REGION: "us-east-1",
};
let port = 18_860;

async function rustfsUp(): Promise<boolean> {
  try {
    return (await fetch(`${ENDPOINT}/health`)).ok;
  } catch {
    return false;
  }
}

/** A fresh prefix per test: `s3://cells/<prefix>` (celld supports bucket prefixes). */
const bucketUrl = (prefix: string) => `s3://cells/${prefix}`;

function run(cmd: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) => {
    const p = spawn(CELLD!, cmd, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout!.on("data", (d) => (out += d));
    p.stderr!.on("data", (d) => (out += d));
    p.on("exit", (code) =>
      code === 0 ? res(out) : rej(new Error(`celld ${cmd[0]} failed:\n${out.slice(-1500)}`)),
    );
  });
}

async function celldNode(
  prefix: string,
): Promise<{ p: ChildProcess; base: string; log: () => string }> {
  const at = port;
  port += 2;
  const p = spawn(
    CELLD!,
    [
      "--bucket",
      bucketUrl(prefix),
      "--endpoint",
      ENDPOINT,
      "--listen",
      `127.0.0.1:${at}`,
      "--internal-listen",
      `127.0.0.1:${at + 1}`,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  p.stdout!.on("data", (d) => (log += d));
  p.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 150 && !log.includes("readiness is open"); i++)
    await new Promise((r) => setTimeout(r, 200));
  if (!log.includes("readiness is open"))
    throw new Error(`celld node did not start:\n${log.slice(-2000)}`);
  return { p, base: `http://127.0.0.1:${at}`, log: () => log };
}
/** celld's WARN/ERROR lines, for diagnosing what it disliked in webrun-cells' writes. */
const complaints = (log: string) =>
  log
    .split("\n")
    .filter((l) => /\b(WARN|ERROR)\b/.test(l))
    .map((l) => l.replace(/^\S+\s+/, "").slice(0, 300));
const stop = (p: ChildProcess) =>
  new Promise<void>((r) => {
    p.once("exit", () => r());
    p.kill("SIGTERM");
  });

async function webrun(project: string, prefix: string) {
  const store = s3ObjectStore({
    endpoint: ENDPOINT,
    bucket: "cells",
    prefix,
    region: "us-east-1",
    ...KEYS,
  });
  const bucket = celldBucket(store, { node: `webrun-${prefix}`, leaseTtlMs: 3_000 });
  const { runtime } = await loadNodeProject(project, {
    // P11G_DRIVER=wasm: the same with SQLite WASM (memdb + page hook), as in browsers
    openSql:
      process.env.P11G_DRIVER === "wasm"
        ? wasmMemoryOpener(
            await ((await import("@sqlite.org/sqlite-wasm")).default as any)({
              print() {},
              printErr() {},
            }),
          )
        : nodeSqliteOpener(),
    files: new MemFilesApi(),
    ownership: bucket.ownership,
    durability: bucket.durability,
    backup: bucket.durability,
  } as never);
  const call = async (path: string) => {
    for (let i = 0; i < 60; i++) {
      const text = await (await runtime.fetch(new Request(`http://w${path}`))).text();
      if (!text.includes("owned by another")) {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
      await new Promise((r) => setTimeout(r, 500)); // the previous owner's lease is still live
    }
    throw new Error("cell never handed over");
  };
  return {
    call,
    store,
    close: async () => {
      await runtime.close();
      await bucket.close();
    },
  };
}

const examples = resolve(__dirname, "../conformance/celld-examples");
const json = async (r: Response) => JSON.parse(await r.text());

describe.skipIf(!CELLD)(
  "P11g celld fleet node ⇄ webrun-cells on a local RustFS bucket",
  async () => {
    const up = await rustfsUp();
    it.skipIf(!up)(
      "the Counter moves celld → webrun-cells → celld through S3",
      async () => {
        const prefix = `t${Date.now().toString(36)}a`;
        const dir = join(mkdtempSync(join(tmpdir(), "rustfs-")), "counter");
        cpSync(join(examples, "counter"), dir, { recursive: true });
        await run(["deploy", ".", "--bucket", bucketUrl(prefix), "--endpoint", ENDPOINT], dir);
        let node = await celldNode(prefix);
        expect((await json(await fetch(`${node.base}/increment?name=a`))).n).toBe(1);
        expect((await json(await fetch(`${node.base}/increment?name=a`))).n).toBe(2);
        await stop(node.p);
        const w = await webrun(dir, prefix);
        const third = await w.call("/increment?name=a");
        expect(third.n, JSON.stringify(third)).toBe(3);
        await w.close();
        await new Promise((r) => setTimeout(r, 3_500)); // webrun's node lease expires
        node = await celldNode(prefix);
        try {
          const fourth = (await json(await fetch(`${node.base}/increment?name=a`))).n;
          expect(
            fourth,
            node
              .log()
              .split("\n")
              .filter((l) => /resum|restor|clone|replica|own/i.test(l))
              .slice(-12)
              .join("\n"),
          ).toBe(4);
        } finally {
          await stop(node.p);
        }
        if (process.env.SHOW_CELLD_WARNINGS)
          process.stdout.write(`CELLD WARNINGS\n${complaints(node.log()).join("\n")}\n`);
      },
      180_000,
    );

    it.skipIf(!up)(
      "alarms cross through celld's wake index on S3 (both directions)",
      async () => {
        const prefix = `t${Date.now().toString(36)}b`;
        const dir = join(mkdtempSync(join(tmpdir(), "rustfs-")), "alarm");
        cpSync(join(examples, "alarm"), dir, { recursive: true });
        await run(["deploy", ".", "--bucket", bucketUrl(prefix), "--endpoint", ENDPOINT], dir);
        // celld arms; webrun-cells fires it.
        let node = await celldNode(prefix);
        expect((await json(await fetch(`${node.base}/arm`))).armed).toBe(true);
        await stop(node.p);
        const w = await webrun(dir, prefix);
        let got: any;
        for (let i = 0; i < 30; i++) {
          got = await w.call("/");
          if (got.fires) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        expect(got).toEqual({ fires: 1, pendingAlarm: null });
        // webrun-cells arms; celld fires it.
        expect((await w.call("/arm")).armed).toBe(true);
        await w.close();
        await new Promise((r) => setTimeout(r, 3_500));
        node = await celldNode(prefix);
        try {
          for (let i = 0; i < 30; i++) {
            got = await json(await fetch(`${node.base}/`));
            if (got.fires === 2) break;
            await new Promise((r) => setTimeout(r, 500));
          }
          expect(
            got,
            node
              .log()
              .split("\n")
              .filter((l) => /wake|alarm/i.test(l))
              .slice(-10)
              .join("\n"),
          ).toEqual({ fires: 2, pendingAlarm: null });
        } finally {
          await stop(node.p);
        }
        if (process.env.SHOW_CELLD_WARNINGS)
          process.stdout.write(`CELLD WARNINGS\n${complaints(node.log()).join("\n")}\n`);
      },
      180_000,
    );

    it.skipIf(!up)(
      "a facet's state moves celld → webrun-cells → celld through S3",
      async () => {
        const prefix = `t${Date.now().toString(36)}f`;
        const dir = join(mkdtempSync(join(tmpdir(), "rustfs-")), "facet-store");
        cpSync(resolve(__dirname, "../conformance/projects/facet-store"), dir, { recursive: true });
        await run(["deploy", ".", "--bucket", bucketUrl(prefix), "--endpoint", ENDPOINT], dir);
        let node = await celldNode(prefix);
        expect(await json(await fetch(`${node.base}/`))).toEqual({ facet: 1, parent: 1 });
        await stop(node.p);
        const w = await webrun(dir, prefix);
        expect(await w.call("/")).toEqual({ facet: 2, parent: 2 });
        await w.close();
        const store = s3ObjectStore({
          endpoint: ENDPOINT,
          bucket: "cells",
          prefix,
          region: "us-east-1",
          ...KEYS,
        });
        const keys = (await store.list("cells/")).filter(
          (k) => k.includes("/ltx/") || k.endsWith("own.json"),
        );
        await new Promise((r) => setTimeout(r, 3_500));
        node = await celldNode(prefix);
        try {
          const got = await json(await fetch(`${node.base}/`));
          expect(
            got,
            `${keys.join("\n")}\n---\n${node
              .log()
              .split("\n")
              .filter((l) => /restor|clone|resum|facet/i.test(l))
              .slice(-12)
              .join("\n")}`,
          ).toEqual({ facet: 3, parent: 3 });
        } finally {
          await stop(node.p);
        }
      },
      180_000,
    );
  },
);
