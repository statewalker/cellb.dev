// Layered files, as Docker builds images: a build container with a writable FilesApi installs the
// dependencies (npm install: node_modules lands in the FilesApi), then that FilesApi is a read-only
// base layer under the runs: each run gets its own writable layer on top, and the base never changes.
// Needs WebAssembly JSPI for wasmer/edgejs (Node 24+) and the npm registry.
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { readText, writeText } from "@statewalker/webrun-files";
import { CompositeFilesApi, cow, readOnly } from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { Wasmer } from "@wasmer/sdk/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContainer } from "../src/container.ts";
import { wasmerContainerEngine } from "../src/engine.ts";
import { HostMounts, installHostFiles } from "../src/files/bridge.ts";
import { createIsolatedPool, type IsolatedPool } from "../src/isolated-pool.ts";

const hasJspi = typeof (WebAssembly as { Suspending?: unknown }).Suspending === "function";
// Behind a TLS-intercepting proxy, the guest must trust its CA (edgejs has its own store).
const ca = process.env.NODE_EXTRA_CA_CERTS
  ? readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8")
  : undefined;
const node = (code: string) => ["node", "-e", code];

describe.skipIf(!hasJspi)("layered files: install once, run read-only", () => {
  const deps = new MemFilesApi(); // the image layer being built
  let pool: IsolatedPool;

  beforeAll(async () => {
    await writeText(
      deps,
      "/package.json",
      JSON.stringify({ name: "app", version: "1.0.0", dependencies: { ms: "2.1.3" } }),
    );
    // plain directories: the host-filesystem protocol has no symlinks
    await writeText(deps, "/.npmrc", "node-linker=hoisted\n");
    pool = createIsolatedPool({
      spawn: () => new Worker(new URL("./fixtures/isolated-edgejs-worker.ts", import.meta.url)),
      image: { packages: ["wasmer/edgejs"] },
      size: 2,
      warmup: node("1"),
    });
  });
  afterAll(async () => {
    await pool?.close();
  });

  it("step 1: a build container with egress installs the dependencies into its writable mount", async () => {
    const wasmer = new Wasmer({ cache: { directory: ".wasmer" } });
    // egress for this trusted build step only: the run containers below have none
    const engine = wasmerContainerEngine(wasmer, { egress: "host" });
    const mounts = new HostMounts();
    const uninstall = installHostFiles(mounts);
    try {
      const build = createContainer(engine, {
        packages: ["wasmer/edgejs"],
        mounts: [{ path: "/app", id: mounts.add(deps) }],
        files: ca ? { "ca.crt": ca } : undefined,
        env: ca
          ? { NODE_EXTRA_CA_CERTS: "/workspace/ca.crt", npm_config_cafile: "/workspace/ca.crt" }
          : undefined,
      });
      await build.start({ enableInternet: true });
      // a host mount cannot be the working directory (Wasmer checks it before any call reaches
      // the host): install into it with --dir
      const r = await build.exec(["npm", "install", "--dir", "/app"]);
      expect(r.exitCode, r.stderr).toBe(0);
      await build.destroy();
    } finally {
      uninstall();
      await engine.close();
      await wasmer.close();
    }
    expect(JSON.parse(await readText(deps, "/node_modules/ms/package.json")).version).toBe("2.1.3");
  });

  it("step 2: runs use the installed packages from a read-only layer, each with its own writable layer", async () => {
    const base = readOnly(deps);
    const layered = () =>
      new CompositeFilesApi(new MemFilesApi()).mount("/node_modules", base, "/node_modules");
    const a = layered();
    const first = await pool.run({
      argv: node(`
        const fs = require("fs");
        const ms = require("/data/node_modules/ms");
        fs.writeFileSync("/data/out.txt", ms(90000));
        let refused = "no";
        try { fs.writeFileSync("/data/node_modules/ms/index.js", "tampered"); } catch (e) { refused = e.code; }
        console.log(JSON.stringify({ result: ms(90000), refused }));
      `),
      files: a,
    });
    expect(first.exitCode, first.stderr).toBe(0);
    const out = JSON.parse(first.stdout);
    expect(out.result).toBe("2m");
    // the volume answers EACCES; the guest sees Wasmer's mapping of a permission refusal
    expect(["EACCES", "EPERM"]).toContain(out.refused);
    expect(await readText(a, "/out.txt")).toBe("2m");
    // the next run: a fresh writable layer over the same base
    const second = await pool.run({
      argv: node(
        `const fs = require("fs"); console.log(JSON.stringify([fs.existsSync("/data/out.txt"), require("/data/node_modules/ms")(1000)]))`,
      ),
      files: layered(),
    });
    expect(JSON.parse(second.stdout)).toEqual([false, "1s"]);
    expect(await readText(deps, "/node_modules/ms/index.js")).not.toBe("tampered");
  });

  it("step 2 with copy-on-write: a run may change the installed files, and only its own layer changes", async () => {
    const top = new MemFilesApi();
    const r = await pool.run({
      argv: node(`
        const fs = require("fs");
        fs.writeFileSync("/data/node_modules/ms/index.js", "module.exports = () => 'patched'");
        console.log(require("/data/node_modules/ms")(1000));
      `),
      files: cow(readOnly(deps), top),
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe("patched\n");
    expect(await readText(top, "/node_modules/ms/index.js")).toBe(
      "module.exports = () => 'patched'",
    );
    expect(await readText(deps, "/node_modules/ms/index.js")).not.toContain("patched");
  });

  it("the run containers have no egress", async () => {
    // (edgejs's fetch() without a network never settles; a socket fails at once: no DNS)
    const r = await pool.run({
      argv: node(
        `require("net").connect(443, "registry.npmjs.org").on("connect", () => { console.log("reached"); process.exit(0) }).on("error", (e) => console.log("blocked", e.code))`,
      ),
      timeoutMs: 30_000,
    });
    expect(r.stdout.trim()).toBe("blocked ENOTFOUND");
  });
});
