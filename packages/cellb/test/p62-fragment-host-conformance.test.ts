// Conformance with several projects in one fragment host (#191): celld's examples loaded side by
// side, each twice, into one runtime, their scenarios run at the same time. Every transcript must
// match celld's recording (conformance/golden) as when the project runs alone (p09). Two copies of
// one project have the same Worker name, classes and bindings; the scenarios that build on what
// they stored (counter, rpc, storage-details, d1-details, queues-api, sql-ingest) only match if
// each copy starts from nothing, so a copy that saw the other's cells, D1 or queues fails them.
// Same-named KV and the rest are kept apart by p61.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFragmentHost, type FragmentHost } from "@statewalker/cellb/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectDir } from "../conformance/projects.js";
import {
  alignDocumentedDifferences,
  goldenDir,
  runScenario,
  scenarios,
  type Target,
  withContentLength,
} from "../conformance/scenarios.js";

/** Projects with one Durable Object binding (their fragment DO), and scenarios that need no
 * WebSocket server, compare no logs and record no known gap. */
const NAMES = [
  "counter",
  "rpc",
  "body",
  "storage-details",
  "d1-details",
  "kv-values",
  "queues-api",
  "sql-ingest",
  "vectordb",
  "worker-details",
];
const COPIES = ["one", "two"];

const golden = (name: string) =>
  JSON.parse(
    readFileSync(join(__dirname, `../conformance/${goldenDir(name)}/${name}.json`), "utf8"),
  );

let host: FragmentHost;
beforeAll(async () => {
  host = createFragmentHost();
  for (const name of NAMES)
    for (const copy of COPIES) await host.add(`${copy}.${name}`, projectDir(name));
}, 120_000);
afterAll(async () => {
  await host?.close();
});

/** A scenario's target: the project's own Worker, inside the shared host. */
function target(id: string): Target {
  const project = host.project(id);
  if (!project) throw new Error(`no fragment ${id}`);
  return {
    origin: "http://127.0.0.1:18701",
    fetch: async (req) => withContentLength(req, await project.runtime.fetch(req)),
    websocket: () => Promise.reject(new Error("no WebSocket in these scenarios")),
  };
}

describe("celld examples side by side in one fragment host (Node) vs recorded celld 0.6.3", () => {
  it("loads every project, each reporting only its own unsupported configuration", () => {
    expect(host.ids()).toHaveLength(NAMES.length * COPIES.length);
    for (const name of NAMES)
      expect(host.project(`one.${name}`)?.unsupported).toEqual(
        host.project(`two.${name}`)?.unsupported,
      );
  });

  it("answers every scenario as celld did, all at once, each copy from its own data", async () => {
    const runs = NAMES.flatMap((name) =>
      COPIES.map(async (copy) => {
        const transcript = await runScenario(target(`${copy}.${name}`), scenarios[name]);
        return { name, copy, transcript };
      }),
    );
    for (const { name, copy, transcript } of await Promise.all(runs)) {
      const expected = golden(name).transcript;
      expect(alignDocumentedDifferences(transcript, expected), `${copy}.${name}`).toEqual(expected);
    }
  }, 120_000);
});
