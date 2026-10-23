import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { bundleProjectForBrowser } from "../../conformance/browser-bundle.ts";
import { s3ObjectStore } from "../../src/bucket/s3-object-store.ts";

// A real celld fleet node and webrun-cells IN CHROMIUM (SQLite WASM on OPFS) share one S3
// bucket (a local RustFS, reached from the page through the dev server's /s3 proxy): cells
// move between them through celld's ownership protocol and LTX logs. Needs CELLD_BIN,
// ESBUILD_DIR and RustFS at RUSTFS_ENDPOINT (default http://127.0.0.1:9100); skipped otherwise.
const CELLD = process.env.CELLD_BIN;
const ENDPOINT = process.env.RUSTFS_ENDPOINT ?? "http://127.0.0.1:9100";
const KEYS = { accessKeyId: "rustfsadmin", secretAccessKey: "rustfssecret" };
const env = {
  ...process.env,
  PATH: `${process.env.ESBUILD_DIR ?? ""}:${process.env.PATH}`,
  AWS_ACCESS_KEY_ID: KEYS.accessKeyId,
  AWS_SECRET_ACCESS_KEY: KEYS.secretAccessKey,
  AWS_REGION: "us-east-1",
};
const examples = resolve(import.meta.dirname, "../../conformance/celld-examples");
const ours = resolve(import.meta.dirname, "../../conformance/projects");
let port = 18_900;

const run = (args: string[], cwd: string) =>
  new Promise<void>((res, rej) => {
    const p = spawn(CELLD!, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout!.on("data", (d) => (out += d));
    p.stderr!.on("data", (d) => (out += d));
    p.on("exit", (c) => (c === 0 ? res() : rej(new Error(out.slice(-1500)))));
  });
async function celldNode(prefix: string): Promise<{ p: ChildProcess; base: string }> {
  const at = port;
  port += 2;
  const p = spawn(
    CELLD!,
    [
      "--bucket",
      `s3://cells/${prefix}`,
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
    throw new Error(`celld node did not start:\n${log.slice(-1500)}`);
  return { p, base: `http://127.0.0.1:${at}` };
}
const stop = (p: ChildProcess) =>
  new Promise<void>((r) => {
    p.once("exit", () => r());
    p.kill("SIGTERM");
  });
const rustfsUp = async () => {
  try {
    return (await fetch(`${ENDPOINT}/health`)).ok;
  } catch {
    return false;
  }
};

async function roundTrip(
  page: import("@playwright/test").Page,
  dir: string,
  projectName: string,
  steps: { celld1: string[]; browser: string[]; celld2: string[] },
) {
  const prefix = `b${Date.now().toString(36)}`;
  await run(["deploy", ".", "--bucket", `s3://cells/${prefix}`, "--endpoint", ENDPOINT], dir);
  const answers = { celld1: [] as string[], browser: [] as string[], celld2: [] as string[] };
  let node = await celldNode(prefix);
  for (const p of steps.celld1) answers.celld1.push(await (await fetch(node.base + p)).text());
  await stop(node.p);

  const project = await bundleProjectForBrowser(projectName);
  await page.goto("/projects/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const r = await page.evaluate((job) => (window as any).__runProject(job), {
    project,
    scenario: projectName,
    paths: steps.browser,
    bucket: {
      endpoint: `${new URL(page.url()).origin}/s3`,
      signAs: ENDPOINT,
      bucket: "cells",
      prefix,
      ...KEYS,
      node: `chromium-${prefix}`,
    },
  });
  expect(r.ok, r.error).toBe(true);
  answers.browser = r.answers;
  const store = s3ObjectStore({
    endpoint: ENDPOINT,
    bucket: "cells",
    prefix,
    region: "us-east-1",
    ...KEYS,
  });
  (answers as any).keys = (await store.list("cells/")).filter(
    (k) => k.includes("/ltx/") || k.endsWith("own.json"),
  );
  await new Promise((res) => setTimeout(res, 3_500)); // the page's node lease expires

  node = await celldNode(prefix);
  try {
    for (const p of steps.celld2) answers.celld2.push(await (await fetch(node.base + p)).text());
  } finally {
    await stop(node.p);
  }
  return answers;
}

test.describe("celld fleet node ⇄ webrun-cells in Chromium on one S3 bucket", () => {
  test.beforeEach(async () => {
    test.skip(!CELLD, "needs CELLD_BIN");
    test.skip(!(await rustfsUp()), "needs RustFS");
  });

  test("Counter: celld → browser → celld", async ({ page }) => {
    test.setTimeout(150_000);
    const dir = join(mkdtempSync(join(tmpdir(), "bucket-browser-")), "counter");
    cpSync(join(examples, "counter"), dir, { recursive: true });
    const a = await roundTrip(page, dir, "counter", {
      celld1: ["/increment?name=a", "/increment?name=a"],
      browser: ["/increment?name=a"],
      celld2: ["/increment?name=a"],
    });
    const n = (t: string) => JSON.parse(t).n;
    expect([...a.celld1, ...a.browser, ...a.celld2].map(n), JSON.stringify(a)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  test("a facet's state: celld → browser → celld", async ({ page }) => {
    test.setTimeout(150_000);
    const dir = join(mkdtempSync(join(tmpdir(), "bucket-browser-")), "facet-store");
    cpSync(join(ours, "facet-store"), dir, { recursive: true });
    const a = await roundTrip(page, dir, "facet-store", {
      celld1: ["/"],
      browser: ["/"],
      celld2: ["/"],
    });
    expect(
      [...a.celld1, ...a.browser, ...a.celld2].map((t) => JSON.parse(t)),
      JSON.stringify(a),
    ).toEqual([
      { facet: 1, parent: 1 },
      { facet: 2, parent: 2 },
      { facet: 3, parent: 3 },
    ]);
  });
});
