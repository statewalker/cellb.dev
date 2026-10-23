// Copies workerd's own Durable Object tests, unchanged, into wrangler projects that celld and
// webrun-cells both run (conformance/workerd-tests/<project>/):
//
//   WORKERD_SRC=/path/to/workerd node scripts/vendor-workerd-tests.mjs
//
// Each upstream `*-test.js` is copied byte-identical below one provenance line. Next to it:
//   wrangler.jsonc — hand-translated from the test's `.wd-test` (one entry of WD_TESTS below);
//   index.js       — a runner: GET / calls every `test(ctrl, env, ctx)` export in module order
//                    and answers { exportName: "ok" | "timeout" | "<Error>: <first line>" }
//                    ("AssertionError: <actual> <operator> <expected>" for a failed assertion);
//                    GET /?skip=a,b leaves those exports out (to split off a known gap).
// The output is committed, so tests need no workerd checkout. The scenarios and the celld
// goldens are wired in conformance/scenarios.ts and recorded by conformance/record-celld.ts.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const src = process.env.WORKERD_SRC;
if (!src) throw new Error("set WORKERD_SRC to a workerd checkout");
const tests = resolve(src, "src/workerd/api/tests");
const out = resolve(import.meta.dirname, "../conformance/workerd-tests");
const commit = execSync("git rev-parse HEAD", { cwd: src }).toString().trim();

// Project name (wd-<upstream basename without -test.js>) → how to build it. Only what the
// .wd-test declares for the main worker: tail workers and TEST_TMPDIR disks are workerd's own
// instrumentation, and every Durable Object class gets SQLite storage (celld and webrun-cells
// have no other kind), whatever `durableObjectStorage` says.
const WD_TESTS = {
  "wd-actor-kv": {
    upstream: "actor-kv-test.js",
    durableObjects: { ns: "ActorKvTest" },
    flags: ["experimental", "nodejs_compat"],
    vars: {},
    workerLoaders: [],
    skip: [],
  },
  // Reached through ctx.exports; the binding only declares the class. The .wd-test also lists
  // `enable_ctx_exports` and `rpc`: defaults at our compatibility_date (since 2025-11-17 and
  // 2024-04-03), which workerd refuses to see listed.
  "wd-sync-kv": {
    upstream: "sync-kv-test.js",
    durableObjects: { MyActor: "MyActor" },
    flags: ["nodejs_compat"],
    vars: {},
    workerLoaders: [],
    skip: [],
  },
  // One .wd-test, two configurations: the alarm outlives deleteAll() only without the flag.
  "wd-delete-all-deletes-alarm-enabled": {
    upstream: "delete-all-deletes-alarm-test.js",
    durableObjects: { ns: "DurableObjectExample" },
    flags: ["experimental", "nodejs_compat", "delete_all_deletes_alarm"],
    vars: { EXPECT_ALARM_DELETED: "true" },
    workerLoaders: [],
    skip: [],
  },
  "wd-delete-all-deletes-alarm-disabled": {
    upstream: "delete-all-deletes-alarm-test.js",
    durableObjects: { ns: "DurableObjectExample" },
    flags: ["experimental", "nodejs_compat", "delete_all_preserves_alarm"],
    vars: { EXPECT_ALARM_DELETED: "false" },
    workerLoaders: [],
    skip: [],
  },
  "wd-sql-restrict-names": {
    upstream: "sql-restrict-names-test.js",
    durableObjects: { ns: "DurableObjectExample" },
    flags: ["nodejs_compat"],
    vars: {},
    workerLoaders: [],
    skip: [],
  },
  "wd-actor-alarms": {
    upstream: "actor-alarms-test.js",
    durableObjects: { ns: "DurableObjectExample" },
    flags: ["experimental", "nodejs_compat"],
    vars: {},
    workerLoaders: [],
    skip: [],
  },
  "wd-actor-alarms-delete": {
    upstream: "actor-alarms-delete-test.js",
    durableObjects: { ns: "DurableObjectExample" },
    flags: ["experimental", "nodejs_compat"],
    vars: {},
    workerLoaders: [],
    skip: [],
  },
  "wd-actor-alarms-in-memory": {
    upstream: "actor-alarms-in-memory-test.js",
    durableObjects: { clearNs: "AlarmClearObject", updateNs: "AlarmUpdateObject" },
    flags: ["experimental", "nodejs_compat"],
    vars: {},
    workerLoaders: [],
    skip: [],
  },
  // Also listed in the .wd-test, left out as defaults at our compatibility_date (2022-11-30):
  // streams_enable_constructors, transformstream_enable_standard_constructor.
  "wd-sql": {
    upstream: "sql-test.js",
    durableObjects: { ns: "DurableObjectExample" },
    flags: ["experimental", "nodejs_compat", "disable_fast_jsg_struct"],
    vars: {},
    workerLoaders: [],
    // They shrink the database with setMaxPageCountForTest, a workerd test hook celld refuses.
    skip: [
      "testAutoRollBackOnCriticalError",
      "testCriticalErrorOnTransactionRollback",
      "testCriticalErrorOnTransactionSyncCommit",
      "testCriticalErrorOnTransactionSyncRollback",
    ],
  },
  "wd-actor-block-concurrency-depth": {
    upstream: "actor-block-concurrency-depth-test.js",
    durableObjects: { ns: "DepthTester" },
    flags: ["experimental", "nodejs_compat", "js_rpc"],
    vars: {},
    workerLoaders: [],
    skip: [],
  },
  "wd-actor-block-concurrency-timer": {
    upstream: "actor-block-concurrency-timer-test.js",
    durableObjects: { ns: "TimerTester" },
    flags: ["experimental", "nodejs_compat", "js_rpc"],
    vars: {},
    workerLoaders: [],
    skip: [],
  },
  // enable_ctx_exports (in the .wd-test): a default at our compatibility_date.
  "wd-actor-stub": {
    upstream: "actor-stub-test.js",
    durableObjects: { ns: "DurableObjectExample" },
    flags: ["experimental", "nodejs_compat", "js_rpc"],
    vars: {},
    workerLoaders: [],
    skip: [],
  },
  "wd-actor-fetch-rejection": {
    upstream: "actor-fetch-rejection-test.js",
    durableObjects: { ns: "FailingActor" },
    flags: ["nodejs_compat"],
    vars: {},
    workerLoaders: [],
    skip: [],
  },
  // Reached through ctx.exports; the binding only declares the class. rpc, enable_ctx_exports
  // and fetcher_no_get_put_delete (in the .wd-test): defaults at our compatibility_date.
  "wd-stub-storage": {
    upstream: "stub-storage-test.js",
    durableObjects: { MyActor: "MyActor" },
    flags: [
      "nodejs_compat",
      "allow_irrevocable_stub_storage",
      "experimental",
      "service_binding_extra_handlers",
    ],
    vars: {},
    workerLoaders: [],
    skip: [],
  },
};

const runner = (
  upstream,
  skip,
) => `// GENERATED by scripts/vendor-workerd-tests.mjs — runs workerd's test exports inside the worker.
import * as mod from "./${upstream}";
export * from "./${upstream}"; // the Durable Object / entrypoint classes (not \`default\`)
const SKIP = new Set(${JSON.stringify(skip)});
const TIMEOUT_MS = 5_000;
// An assertion is reported by its fields, not its message: each engine's node:assert words
// the same failure differently.
const show = (v) => {
  if (v === null || typeof v !== "object" || v instanceof RegExp || v instanceof Error) return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
};
const first = (e) =>
  e?.name === "AssertionError" && "operator" in e
    ? \`AssertionError: \${show(e.actual)} \${e.operator} \${show(e.expected)}\`.slice(0, 300)
    : \`\${e?.name ?? "Error"}: \${String(e?.message ?? e).split("\\n")[0].slice(0, 200)}\`;
export default {
  async fetch(request, env, ctx) {
    const asked = new URL(request.url).searchParams.get("skip")?.split(",") ?? [];
    const skip = new Set([...SKIP, ...asked]);
    const out = {};
    for (const name of Object.keys(mod)) {
      if (typeof mod[name]?.test !== "function" || skip.has(name)) continue;
      let timer;
      out[name] = await Promise.race([
        Promise.resolve()
          .then(() => mod[name].test({}, env, ctx))
          .then(() => "ok", first),
        new Promise((r) => (timer = setTimeout(() => r("timeout"), TIMEOUT_MS))),
      ]);
      clearTimeout(timer);
    }
    return Response.json(out);
  },
};
`;

for (const [name, t] of Object.entries(WD_TESTS)) {
  const dir = resolve(out, name);
  mkdirSync(dir, { recursive: true });
  const header = `// VENDORED from cloudflare/workerd@${commit} src/workerd/api/tests/${t.upstream} (Apache-2.0). Do not edit.\n`;
  writeFileSync(
    resolve(dir, t.upstream),
    header + readFileSync(resolve(tests, t.upstream), "utf8"),
  );
  const config = {
    name,
    main: "index.js",
    compatibility_date: "2026-01-01",
    compatibility_flags: t.flags,
    ...(Object.keys(t.vars).length ? { vars: t.vars } : {}),
    durable_objects: {
      bindings: Object.entries(t.durableObjects).map(([b, c]) => ({ name: b, class_name: c })),
    },
    migrations: [{ tag: "v1", new_sqlite_classes: [...new Set(Object.values(t.durableObjects))] }],
    ...(t.workerLoaders.length ? { worker_loaders: t.workerLoaders } : {}),
  };
  writeFileSync(resolve(dir, "wrangler.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(resolve(dir, "index.js"), runner(t.upstream, t.skip));
}
copyFileSync(resolve(src, "LICENSE"), resolve(out, "LICENSE"));
writeFileSync(
  resolve(out, "projects.json"),
  `${JSON.stringify(Object.keys(WD_TESTS).sort(), null, 2)}\n`,
);
console.log(`vendored ${Object.keys(WD_TESTS).length} workerd test(s) from ${commit}`);
