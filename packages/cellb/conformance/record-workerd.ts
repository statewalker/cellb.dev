/**
 * Runs every scenario on workerd (through Miniflare 4) and checks that celld's golden agrees:
 *   npx tsx conformance/record-workerd.ts [name...]
 * Writes conformance/golden-workerd/<name>.json. Exits 1 when a transcript differs from
 * golden/<name>.json and the scenario has no `workerdDiffers`, or when `workerdDiffers` is set
 * but they agree (a stale entry). Projects using bindings beyond Durable Objects and vars are
 * skipped: those are celld's (or our) simulators, not workerd's.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Miniflare } from "miniflare";
import { parseJsonc } from "../src/project/jsonc.ts";
import { startReferenceServer } from "../test/ws-reference-server.ts";
import { httpTarget } from "./http-target.ts";
import { projectDir } from "./projects.ts";
import { alignDocumentedDifferences, runScenario, scenarios } from "./scenarios.ts";

const MAPPED = new Set([
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "vars",
  "durable_objects",
  "migrations",
]);
// Flags only celld knows (workerd refuses to start on them).
const CELLD_ONLY_FLAGS = new Set(["sqlite_vec"]);
const here = import.meta.dirname;
const root = resolve(here, "../../..");
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenarios);
const version = JSON.parse(
  readFileSync(resolve(here, "../node_modules/miniflare/package.json"), "utf8"),
).version;
mkdirSync(resolve(here, "golden-workerd"), { recursive: true });
let failed = false;

for (const name of names) {
  const scenario = scenarios[name];
  const dir = projectDir(name);
  const config = parseJsonc(readFileSync(join(dir, "wrangler.jsonc"), "utf8")) as Record<
    string,
    unknown
  > & {
    main: string;
    compatibility_date: string;
    compatibility_flags?: string[];
    vars?: Record<string, string>;
    durable_objects?: { bindings: { name: string; class_name: string }[] };
  };
  const unmapped = [
    ...Object.keys(config).filter((k) => !MAPPED.has(k)),
    ...(config.compatibility_flags ?? []).filter((f) => CELLD_ONLY_FLAGS.has(f)),
  ];
  if (unmapped.length) {
    console.log(`skip ${name}: ${unmapped.join(", ")}`);
    continue;
  }
  const ref = scenario.wsServer ? await startReferenceServer() : undefined;
  const mf = new Miniflare({
    modules: true,
    scriptPath: join(dir, config.main),
    modulesRoot: dir,
    // As wrangler: .js/.mjs are ES modules (Miniflare's default reads .js as CommonJS).
    modulesRules: [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }],
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags ?? [],
    bindings: config.vars ?? {},
    durableObjects: Object.fromEntries(
      (config.durable_objects?.bindings ?? []).map((b) => [
        b.name,
        { className: b.class_name, useSQLite: true },
      ]),
    ),
  });
  try {
    const url = await mf.ready;
    // workerd's stack traces name files of this checkout: kept out of the committed goldens.
    const transcript = JSON.parse(
      JSON.stringify(
        await runScenario(
          httpTarget(url.origin, ref ? `ws://127.0.0.1:${ref.port}` : undefined),
          scenario,
        ),
      )
        .split(root)
        .join("{root}"),
    );
    writeFileSync(
      resolve(here, "golden-workerd", `${name}.json`),
      `${JSON.stringify({ workerd: `miniflare ${version}`, transcript }, null, 2)}\n`,
    );
    const goldenFile = resolve(here, "golden", `${name}.json`);
    if (!existsSync(goldenFile)) {
      console.log(`? ${name}: no celld golden`);
      continue;
    }
    const celld = JSON.parse(readFileSync(goldenFile, "utf8")).transcript;
    const agrees = isDeepStrictEqual(alignDocumentedDifferences(transcript, celld), celld);
    if (agrees && scenario.workerdDiffers) {
      failed = true;
      console.log(`✗ ${name}: agrees with celld, but workerdDiffers is set (stale)`);
    } else if (agrees) console.log(`✓ ${name} agrees with celld`);
    else if (scenario.workerdDiffers)
      console.log(`~ ${name}: differs from celld (${scenario.workerdDiffers})`);
    else {
      failed = true;
      console.log(`✗ ${name}: differs from celld`);
    }
  } catch (e) {
    failed = true;
    console.log(`✗ ${name}: ${(e as Error).message.split("\n")[0]}`);
  } finally {
    await mf.dispose().catch(() => {}); // a project that failed to load has nothing to stop
    await ref?.close();
  }
}
process.exit(failed ? 1 : 0);
