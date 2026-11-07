// Precompiles the conformance projects into what the site's example pages load:
//
//   src/generated/examples.json        one entry per scenario: its sources, requests and the
//                                      responses celld (or workerd) recorded
//   public/built/<project>/            the project as `cellb build` writes it (buildProject):
//                                      wrangler.json, worker.js, assets/ and cellb.json, which the
//                                      pages load with the browser's loadProject
//   public/vendor/sqlite-vec/          SQLite WASM with sqlite-vec, for the `vectordb` example
//
// Run by `pnpm dev` and `pnpm build` (predev, prebuild) with tsx, which reads cellb's TypeScript
// sources as the conformance tests do. Both outputs are generated: they are not committed.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  goldenDir,
  type Scenario,
  type Step,
  scenarios,
} from "../../packages/cellb/conformance/scenarios.ts";
import { buildProject } from "../../packages/cellb/src/project/build.ts";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFORMANCE = resolve(SITE, "../packages/cellb/conformance");
const CELLD_EXAMPLES = "https://github.com/denoland/celld/tree/v0.6.3/examples";
const REPO_TREE = "https://github.com/statewalker/cellb.dev/tree/HEAD";

type Origin = "celld" | "cellb" | "workerd";

/** What each of celld's examples shows, in a line (celld's examples have no header comment). */
const CELLD_ABOUT: Record<string, string> = {
  hello: "The smallest Worker: one fetch handler that answers with the request URL.",
  webapi:
    "The Web APIs a Worker has without imports: URL, URLSearchParams, TextEncoder, btoa and atob, Headers.",
  counter: "A Durable Object per name, keeping a counter in its storage.",
  kv: "A KV namespace behind GET, PUT and DELETE on /KEY.",
  d1: "A D1 database: a guestbook whose table is created on the first request.",
  rpc: "Calling a Durable Object's methods over RPC instead of fetch.",
  router: "A Worker that routes each path to its own Durable Object.",
  body: "A Durable Object that reads request bodies: it sums the numbers sent as JSON and reports the length of other bodies.",
  async: "A Durable Object that waits 100 ms before each read and write of its counter.",
  alarm:
    "A Durable Object alarm: /arm sets it two seconds ahead, and the object counts how often it fired.",
  wsecho:
    "A Durable Object that accepts WebSockets (hibernation API) and echoes each message with a running count.",
  queues:
    "A queue producer and consumer: one job is processed, the other is retried until it lands in the dead-letter queue.",
  "dynamic-worker-tails":
    "A Worker Loader binding that loads code at run time, with a Tail Worker that sees its logs.",
  workflow: "A Workflow whose one step fetches a URL and counts its bytes and lines.",
  vectordb: "Nearest-colour search with sqlite-vec, in a Durable Object's SQLite.",
  wsclient: "A Durable Object that opens an outgoing WebSocket and stores the first message.",
  cron: "A cron trigger that runs once a minute and logs its scheduled time.",
  r2: "An R2 bucket behind GET, PUT and DELETE on /KEY.",
  facets:
    "Durable Object facets: a supervisor object runs a child object, with storage of its own, from code loaded at run time.",
  "static-assets":
    "A project with static assets only, no Worker code, with _headers and _redirects files.",
};

const isText = (p: string) => /\.(m?[jt]s|jsonc?|html?|css|txt|md|svg|xml)$/i.test(p);

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out;
}

/** The project's directory and where it comes from (the same lookup as conformance/projects.ts). */
function locate(project: string): { dir: string; origin: Origin } {
  for (const [sub, origin] of [
    ["projects", "cellb"],
    ["workerd-tests", "workerd"],
  ] as const)
    if (existsSync(join(CONFORMANCE, sub, project)))
      return { dir: join(CONFORMANCE, sub, project), origin };
  return { dir: join(CONFORMANCE, "celld-examples", project), origin: "celld" };
}

/** The leading `//` comment of a file, as one paragraph. */
function headerComment(text: string): string {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\/\/ ?(.*)$/.exec(line);
    if (!m) break;
    lines.push(m[1]);
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

function describeStep(step: Step): string {
  if ("waitMs" in step) return `wait ${step.waitMs / 1000} s`;
  if ("ws" in step)
    return `WebSocket ${step.ws}: send ${step.send.map((m) => JSON.stringify(m)).join(", ")}, receive ${step.receive}`;
  const body = step.body
    ? ` ${step.body.length > 60 ? `${step.body.slice(0, 57)}…` : step.body}`
    : "";
  return `${step.method ?? "GET"} ${step.path}${body}`;
}

/** How long a run takes at least: its waits, plus the time it lets logs settle. */
const runSeconds = (s: Scenario) =>
  Math.round(
    (s.steps.reduce((n, st) => n + ("waitMs" in st ? st.waitMs : 0), 0) +
      (s.logs ? (s.settleMs ?? 1500) : 0)) /
      1000,
  );

// sqlite-vec's SQLite WASM finds its .wasm next to its own module, which a bundle moves: the
// worker imports it unbundled from /vendor/sqlite-vec/ (the `vectordb` example).
const vec = join(SITE, "node_modules/sqlite-vec-wasm-demo");
mkdirSync(join(SITE, "public/vendor/sqlite-vec"), { recursive: true });
for (const f of ["sqlite3.mjs", "sqlite3.wasm"])
  copyFileSync(join(vec, f), join(SITE, "public/vendor/sqlite-vec", f));

const bundles = new Map<string, Promise<void>>();
rmSync(join(SITE, "public/built"), { recursive: true, force: true });
mkdirSync(join(SITE, "src/generated"), { recursive: true });

async function writeBundle(project: string, dir: string) {
  await buildProject(dir, join(SITE, "public/built", project));
}

const entries = [];
for (const [name, s] of Object.entries(scenarios)) {
  const project = s.project ?? name;
  const { dir, origin } = locate(project);
  if (!bundles.has(project)) bundles.set(project, writeBundle(project, dir));
  const files = listFiles(dir)
    .filter((p) => isText(p) && !p.endsWith("README.md"))
    .map((path) => ({ path, text: readFileSync(join(dir, path), "utf8") }));
  const main = files.find((f) => f.path === "index.js") ?? files[0];
  // workerd's tests: the generated index.js runs the vendored test file, whose header names it.
  const vendored = files.find((f) => f.text.startsWith("// VENDORED from cloudflare/workerd@"));
  const upstream = vendored && /cloudflare\/workerd@(\w+) (\S+)/.exec(vendored.text);
  const golden = JSON.parse(
    readFileSync(join(CONFORMANCE, goldenDir(name), `${name}.json`), "utf8"),
  );
  entries.push({
    name,
    project,
    origin,
    about:
      origin === "celld"
        ? (CELLD_ABOUT[project] ?? "")
        : origin === "workerd"
          ? `workerd's own test file ${upstream?.[2].split("/").pop()}, run by a small Worker that calls each of its tests and answers with their results.`
          : headerComment(main?.text ?? ""),
    source:
      origin === "celld"
        ? `${CELLD_EXAMPLES}/${project}`
        : `${REPO_TREE}/packages/cellb/conformance/${origin === "cellb" ? "projects" : "workerd-tests"}/${project}`,
    upstream: upstream
      ? `https://github.com/cloudflare/workerd/blob/${upstream[1]}/${upstream[2]}`
      : undefined,
    files,
    steps: s.steps.map(describeStep),
    seconds: runSeconds(s),
    logs: !!s.logs,
    needsServer: !!s.wsServer,
    judge: s.judge === "workerd" ? "workerd" : "celld",
    knownGap: s.knownGap,
    workerdDiffers: s.workerdDiffers,
    recorded: golden,
  });
}
await Promise.all(bundles.values());
writeFileSync(join(SITE, "src/generated/examples.json"), JSON.stringify(entries, null, 1));
console.log(`examples: ${entries.length} scenarios, ${bundles.size} projects bundled`);
