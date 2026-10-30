/**
 * Runs the builder step by step on Node, exactly as the browser does (esbuild-wasm, sources in a
 * FilesApi, packages from the npm registry; only Astro's compiler is the native build), and
 * writes one trace file per step to traces/<app>/, with a SUMMARY.md:
 *
 *   tsx scripts/trace-build.mts emdash      # the EmDash template (../emdash)
 *   tsx scripts/trace-build.mts app         # the small Astro app (app/)
 *   node scripts/trace-run.mjs emdash       # then: evaluate traces/<app>/worker.js and request it
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transform } from "@astrojs/compiler-rs";
import { CELLS_GLOBALS_MODULE, cellbHostModule } from "@statewalker/cellb/host-modules";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { npmPackages } from "@statewalker/webrun-bundler";
import { npmRegistrySource } from "@statewalker/webrun-modules";
import { SqliteFilesApi } from "@statewalker/webrun-files-sqlite";
import { existsSync, readFileSync } from "node:fs";
import { cachedSource, prefetch } from "../src/builder/package-cache.ts";
import * as esbuild from "esbuild-wasm";
import { buildAstroApp } from "../src/builder/build.ts";
import { preloadVfs, runAstroConfig } from "../src/builder/integrations.ts";
import { Trace } from "../src/builder/trace.ts";
import { appFiles } from "../test/load-app.ts";

const app = process.argv[2] ?? "emdash";
const dir = join(import.meta.dirname, "../traces", app);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const trace = new Trace((e) => {
  if (["resolve", "transform", "virtual"].includes(e.step)) return; // too many to echo
  if (e.step === "packages" && !/^(prefetch|preload)/.test(e.what)) return;
  console.log(
    `[${String(e.t).padStart(6)} ms] ${e.step.padEnd(12)} ${e.what}${e.ms !== undefined ? ` (${e.ms} ms)` : ""}`,
  );
});

const files = await appFiles(
  app === "emdash"
    ? join(import.meta.dirname, "../../emdash")
    : join(import.meta.dirname, "../app"),
);
// Packages: a persistent cache in SQLite (the same SqliteFilesApi a Durable Object or a browser
// worker on OPFS uses), filled N at a time before the build, from the last build's lock if any.
const cacheDb = await newNodeSqliteDb({ path: join(import.meta.dirname, "../traces/package-cache.db") });
// Uncompressed, 256 KiB blocks: a file read is a range of a pack; a compressed 1 MiB block
// would be inflated whole for every small file.
const cache = new SqliteFilesApi(cacheDb, { compression: null, blockSize: 256 * 1024 });
await cache.init();
const source = cachedSource(cache, npmRegistrySource() as never, trace);
const lockPath = join(import.meta.dirname, "../traces", `${app}.lock.json`);
const lock = existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, "utf8")) as string[]) : undefined;
const projectManifest = JSON.parse(new TextDecoder().decode((await files.stats("/app/package.json")) ? await (async () => { const c: Uint8Array[] = []; for await (const x of files.read("/app/package.json")) c.push(x); return c[0]; })() : new Uint8Array()));
// Without a lock, the walk of the whole tree (prefetch without `lock`) over-fetches: on demand.
if (lock) await prefetch(source, projectManifest, { lock, trace, concurrency: 16 });
const packages = npmPackages({ source: source as never });
let extra = {};
let failed: unknown;
try {
  if (app === "emdash") {
    const { vfs, mounts } = await trace.time("packages", "preload for build-time code", () =>
      preloadVfs(
        files,
        "/app",
        packages,
        [["emdash"], ["@emdash-cms/admin", "emdash"], ["astro"]],
        trace,
      ),
    );
    const integration = await trace.time(
      "config",
      "run astro.config.mjs and the integrations",
      () =>
        runAstroConfig({
          esbuild,
          files,
          root: "/app",
          packages,
          vfs,
          trace,
          evaluate: (code) =>
            import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`),
        }),
    );
    extra = {
      integration,
      nodeMounts: mounts,
      hostModules: cellbHostModule,
      inject: [CELLS_GLOBALS_MODULE],
      session: {
        driver: "unstorage/drivers/cloudflare-kv-binding",
        options: { binding: "SESSION" },
      },
    };
  }
  const built = await trace.time("bundle", "build the Worker", () =>
    buildAstroApp({
      esbuild,
      transform: transform as never,
      files,
      root: "/app",
      packages,
      trace,
      ...extra,
    }),
  );
  writeFileSync(join(dir, "worker.js"), built.code);
  writeFileSync(lockPath, JSON.stringify([...source.used].sort(), null, 1));
  await trace.time("packages", "flush the package cache", () => source.flush());
  mkdirSync(join(dir, "client/_astro"), { recursive: true });
  for (const [url, bytes] of built.clientAssets) writeFileSync(join(dir, "client", url), bytes);
  // The "run" step is scripts/trace-run.mjs, in a process of its own (the module is large).
} catch (err) {
  failed = err;
}

// One file per step, and a summary.
const steps = trace.steps();
let n = 0;
for (const [step, events] of Object.entries(steps))
  writeFileSync(
    join(dir, `${String(++n).padStart(2, "0")}-${step}.json`),
    JSON.stringify(events, null, 1),
  );
const lines = [
  `# Build trace: ${app}`,
  "",
  failed
    ? `**Failed:** ${String((failed as Error)?.message ?? failed).slice(0, 1500)}`
    : "**Succeeded.**",
  "",
  "| step | events | ms (sum of timed events) |",
  "|---|---|---|",
];
for (const [step, events] of Object.entries(steps))
  lines.push(`| ${step} | ${events.length} | ${events.reduce((s, e) => s + (e.ms ?? 0), 0)} |`);
lines.push("", "## Timeline (timed events)", "");
for (const e of trace.events)
  if (e.ms !== undefined && e.ms > 200)
    lines.push(`- ${e.t} ms · ${e.step} · ${e.what} (${e.ms} ms)`);
writeFileSync(join(dir, "SUMMARY.md"), `${lines.join("\n")}\n`);
console.log(`\ntraces written to ${dir}`);
if (failed) process.exitCode = 1;
