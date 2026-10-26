import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { signV4 } from "../src/bucket/s3-object-store.js";
import { freePort } from "./free-port.js";

export const RUSTFS_KEYS = { accessKeyId: "rustfsadmin", secretAccessKey: "rustfssecret" };

/**
 * The S3 bucket of one test run (vitest's and Playwright's global setup): sets
 * RUSTFS_ENDPOINT and TEST_BUCKET for the tests. Only the celld tests use S3, so without
 * CELLD_BIN it does nothing. RUSTFS_ENDPOINT, when set, is reused (CI, interop-env.sh);
 * otherwise a RustFS from interop-env.sh's cache runs on a free port with a temp data dir,
 * and the returned function stops it. The bucket, `cellb-<random>`, is left in place: a
 * shared RustFS keeps it, a temp one goes with its data dir.
 */
export async function setupTestBucket(): Promise<() => void> {
  if (!process.env.CELLD_BIN || process.env.TEST_BUCKET) return () => {};
  let stop = () => {};
  let endpoint = process.env.RUSTFS_ENDPOINT;
  if (!endpoint) {
    const bin = execFileSync(resolve(import.meta.dirname, "../scripts/interop-env.sh"), [
      "--rustfs-bin",
    ])
      .toString()
      .trim();
    const port = await freePort();
    const data = mkdtempSync(join(tmpdir(), "cellb-rustfs-"));
    const p: ChildProcess = spawn(bin, ["server", "--address", `127.0.0.1:${port}`, data], {
      env: {
        ...process.env,
        RUSTFS_ACCESS_KEY: RUSTFS_KEYS.accessKeyId,
        RUSTFS_SECRET_KEY: RUSTFS_KEYS.secretAccessKey,
      },
      stdio: "ignore",
    });
    stop = () => {
      p.kill("SIGKILL");
      rmSync(data, { recursive: true, force: true });
    };
    process.once("exit", stop); // also when the runner exits without tearing down
    endpoint = `http://127.0.0.1:${port}`;
  }
  const bucket = `cellb-${Math.random().toString(36).slice(2, 10)}`;
  // A fresh RustFS answers before it accepts S3 requests: retry until the bucket is there.
  let status = 0;
  for (let i = 0; i < 120 && status !== 200; i++) {
    const url = new URL(`${endpoint}/${bucket}`);
    status = await fetch(url, {
      method: "PUT",
      headers: await signV4("PUT", url, {}, undefined, { region: "us-east-1", ...RUSTFS_KEYS }),
    }).then(
      (r) => r.status,
      () => 0,
    );
    if (status !== 200) await new Promise((r) => setTimeout(r, 250));
  }
  if (status !== 200) {
    stop();
    throw new Error(`test bucket ${bucket} not created at ${endpoint} (HTTP ${status})`);
  }
  process.env.RUSTFS_ENDPOINT = endpoint;
  process.env.TEST_BUCKET = bucket;
  return stop;
}

/** vitest's globalSetup (vitest.config.ts). */
export const setup = setupTestBucket;
