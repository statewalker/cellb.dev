// The fragment host on Node (#191): several wrangler.jsonc projects side by side in one runtime,
// each in its own namespace, with one fragment DO per project at idFromName(<project-id>) reached
// at /fragments/{id}/…
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildProject, createFragmentHost, loadProject } from "@statewalker/cellb/node";
import { afterEach, describe, expect, test } from "vitest";
import { projectDir } from "../conformance/projects.js";

const PKG = resolve(import.meta.dirname, "..");
const ALPHA = join(PKG, "test/fixtures/fragments/alpha");
const BETA = join(PKG, "test/fixtures/fragments/beta");
const COUNTER = join(PKG, "conformance/celld-examples/counter");

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const req = (path: string) => new Request(`http://localhost${path}`);
const opened: { close(): Promise<void> }[] = [];
const track = <T extends { close(): Promise<void> }>(p: T) => {
  opened.push(p);
  return p;
};
afterEach(async () => {
  for (const p of opened.splice(0)) await p.close();
});

async function json(host: { fetch(r: Request): Promise<Response> }, path: string) {
  const res = await host.fetch(req(path));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("the fragment host on Node", () => {
  test("loads two projects with the same class and binding names side by side, apart", async () => {
    const host = track(createFragmentHost());
    await host.add("org.example.alpha", ALPHA);
    await host.add("org.example.beta", BETA);
    expect(host.ids()).toEqual(["org.example.alpha", "org.example.beta"]);

    expect(await json(host, "/fragments/org.example.alpha/x")).toMatchObject({
      label: "alpha",
      n: 1,
    });
    expect(await json(host, "/fragments/org.example.alpha/x")).toMatchObject({ n: 2 });
    // The same class, binding and Worker name in the other project: its own data.
    expect(await json(host, "/fragments/org.example.beta/x")).toMatchObject({
      label: "beta",
      n: 1,
    });
    await json(host, "/fragments/org.example.alpha/kv?put=from-alpha");
    expect(await json(host, "/fragments/org.example.beta/kv")).toEqual({ kv: null });
    expect(await json(host, "/fragments/org.example.alpha/kv")).toEqual({ kv: "from-alpha" });
  });

  test("routes /fragments/{id}/… to the fragment DO at idFromName(<id>), the prefix stripped", async () => {
    const host = track(createFragmentHost());
    await host.add("org.example.alpha", ALPHA);
    const seen = await json(host, "/fragments/org.example.alpha/notes/1?q=2");
    expect(seen.path).toBe("/notes/1");
    const ns = host.project("org.example.alpha")?.runtime.env.FRAGMENT as {
      idFromName(name: string): { toString(): string };
    };
    expect(seen.id).toBe(ns.idFromName("org.example.alpha").toString());
    // The bare prefix reaches the fragment DO at "/".
    expect((await json(host, "/fragments/org.example.alpha")).path).toBe("/");
  });

  test("answers 404 for a fragment it does not hold, and for a path outside /fragments/", async () => {
    const host = track(createFragmentHost());
    await host.add("org.example.alpha", ALPHA);
    expect((await host.fetch(req("/fragments/org.example.nope/x"))).status).toBe(404);
    expect((await host.fetch(req("/elsewhere"))).status).toBe(404);
    // A malformed escape is a fragment it does not hold, not an error.
    expect((await host.fetch(req("/fragments/%E0/x"))).status).toBe(404);
  });

  test("reports a project's unsupported bindings for that project only", async () => {
    const host = track(createFragmentHost());
    const alpha = await host.add("org.example.alpha", ALPHA);
    const beta = await host.add("org.example.beta", BETA);
    expect(alpha.unsupported).toEqual([]);
    expect(beta.unsupported).toEqual(["compatibility_flags: no_such_flag_for_test"]);
    expect(host.project("org.example.alpha")?.unsupported).toEqual([]);
  });

  test("adds and removes projects while running; the others keep serving; data is kept", async () => {
    const data = tmp("cellb-fragments-");
    const host = track(createFragmentHost({ data }));
    await host.add("org.example.alpha", ALPHA);
    await host.add("org.example.beta", BETA);
    await json(host, "/fragments/org.example.beta/x");
    await host.remove("org.example.beta");
    expect(host.ids()).toEqual(["org.example.alpha"]);
    expect((await host.fetch(req("/fragments/org.example.beta/x"))).status).toBe(404);
    expect(await json(host, "/fragments/org.example.alpha/x")).toMatchObject({ n: 1 });
    // Added again, it finds its data.
    await host.add("org.example.beta", BETA);
    expect(await json(host, "/fragments/org.example.beta/x")).toMatchObject({ n: 2 });
  });

  test("refuses a second project under one id, and an id that is not a path segment", async () => {
    const host = track(createFragmentHost());
    await host.add("org.example.alpha", ALPHA);
    await expect(host.add("org.example.alpha", BETA)).rejects.toThrow(/already/);
    await expect(host.add("../escape", BETA)).rejects.toThrow(/id/);
    // Ids are lowercase: two that differ in case would share a data directory on a
    // case-insensitive filesystem.
    await expect(host.add("org.example.Beta", BETA)).rejects.toThrow(/id/);
  });

  test("names its entry binding when the project has no FRAGMENT binding", async () => {
    const host = track(createFragmentHost());
    // The counter example's only Durable Object binding is the entry by default.
    await host.add("counter", COUNTER);
    const res = await host.fetch(req("/fragments/counter/increment?name=a"));
    expect(res.status).toBeLessThan(500);
  });

  test("takes a project's one declared Durable Object binding as its entry, beside D1 or KV", async () => {
    const host = track(createFragmentHost());
    // The runtime's own hidden bindings (KV, D1, queues) are not the project's: never its entry.
    const d1 = await host.add("d1-details", projectDir("d1-details"));
    expect(d1.entry).toBe("OBJ");
    await expect(host.add("hidden", ALPHA, { entry: "__CELLS_KV_OBJECTS" })).rejects.toThrow(
      /no Durable Object binding/,
    );
  });

  test("refuses a built folder: its bundle reads the process's globals, one project per process", async () => {
    const out = tmp("cellb-built-");
    await buildProject(ALPHA, out);
    const host = track(createFragmentHost());
    await expect(host.add("org.example.alpha", out)).rejects.toThrow(/source/);
    // However it is named: a file: URL string or URL, or an http(s) URL (always a built folder).
    await expect(host.add("org.example.a1", pathToFileURL(out).href)).rejects.toThrow(/source/);
    await expect(host.add("org.example.a2", pathToFileURL(out))).rejects.toThrow(/source/);
    await expect(host.add("org.example.a3", "https://example.org/built/")).rejects.toThrow(
      /source/,
    );
    // A source folder named by a file: URL is a source folder.
    await host.add("org.example.alpha", pathToFileURL(ALPHA));
    expect(host.ids()).toEqual(["org.example.alpha"]);
  });

  test("a remove or a close during an add wins: the project does not stay running", async () => {
    const host = track(createFragmentHost());
    const adding = host.add("org.example.alpha", ALPHA);
    await host.remove("org.example.alpha");
    await expect(adding).rejects.toThrow(/removed/);
    expect(host.ids()).toEqual([]);
    const again = host.add("org.example.beta", BETA);
    await host.close();
    await expect(again).rejects.toThrow(/closed|removed/);
    expect(host.ids()).toEqual([]);
    await expect(host.add("org.example.alpha", ALPHA)).rejects.toThrow(/closed/);
  });
});

describe("the storage layout", () => {
  test("keeps a single-project host's data where it is: fragments live under fragments/<id>/", async () => {
    const data = tmp("cellb-data-");
    const single = await loadProject(COUNTER, { data });
    await single.fetch(req("/increment?name=alpha"));
    await single.close();
    const before = readdirSync(data).sort();

    const host = createFragmentHost({ data });
    await host.add("org.example.alpha", ALPHA);
    await json(host, "/fragments/org.example.alpha/x");
    await host.close();
    expect(existsSync(join(data, "fragments", "org.example.alpha"))).toBe(true);
    expect(readdirSync(data).sort()).toEqual([...before, "fragments"].sort());

    // The single-project host reads its layout as before (no migration, nothing to roll back).
    const again = track(await loadProject(COUNTER, { data }));
    const n = (await (await again.fetch(req("/increment?name=alpha"))).json()) as { n: number };
    expect(n.n).toBe(2);
  });
});

// statewalker-root#259: a disabled fragment answers 503 and an unknown one 404 without waking a
// DO, and `/peers/{self}/…` is `/…`.
describe("disabled fragments and the host's own peer path", () => {
  test("a disabled fragment answers 503 without waking its DO; enabled again, it counts on", async () => {
    // On disk: enabling loads the project again, and its cells must still be there.
    const host = track(createFragmentHost({ data: tmp("cellb-disable-") }));
    await host.add("org.example.alpha", ALPHA);
    expect(await json(host, "/fragments/org.example.alpha/x")).toMatchObject({ n: 1 });
    await host.disable("org.example.alpha");
    expect(host.state("org.example.alpha")).toBe("disabled");
    expect(host.ids()).toEqual(["org.example.alpha"]);
    expect(host.project("org.example.alpha")).toBeUndefined();
    for (let i = 0; i < 3; i++) {
      const res = await host.fetch(req("/fragments/org.example.alpha/x"));
      expect(res.status).toBe(503);
      expect(await res.text()).toBe('fragment "org.example.alpha" is disabled');
    }
    expect((await host.fetch(req("/fragments/org.example.nope/x"))).status).toBe(404);
    await host.enable("org.example.alpha");
    expect(host.state("org.example.alpha")).toBe("enabled");
    // Its DO saw none of the 503s.
    expect(await json(host, "/fragments/org.example.alpha/x")).toMatchObject({ n: 2 });
    // Removed: unknown.
    await host.disable("org.example.alpha");
    await host.remove("org.example.alpha");
    expect(host.state("org.example.alpha")).toBeUndefined();
    expect((await host.fetch(req("/fragments/org.example.alpha/x"))).status).toBe(404);
    await expect(host.enable("org.example.alpha")).rejects.toThrow("not on this host");
  });

  test("/peers/{self}/fragments/{id}/… answers as /fragments/{id}/…; another peer's does not", async () => {
    const host = track(createFragmentHost({ peerId: "peer-self" }));
    await host.add("org.example.alpha", ALPHA);
    const direct = await json(host, "/fragments/org.example.alpha/notes/1");
    const viaPeer = await json(host, "/peers/peer-self/fragments/org.example.alpha/notes/1");
    expect(viaPeer).toMatchObject({ n: 2, path: "/notes/1", id: direct.id });
    expect((await host.fetch(req("/peers/peer-other/fragments/org.example.alpha/x"))).status).toBe(
      404,
    );
  });
});

// The merge gate's pass 1 on #248 (H1): a disable that comes while an enable loads wins.
describe("a disable during an enable", () => {
  test("cancels the enable: the fragment stays disabled", async () => {
    const host = track(createFragmentHost({ data: tmp("cellb-disable-race-") }));
    await host.add("org.example.alpha", ALPHA);
    await host.disable("org.example.alpha");
    const enabling = host.enable("org.example.alpha");
    await host.disable("org.example.alpha");
    await expect(enabling).rejects.toThrow(/disabled/);
    expect(host.state("org.example.alpha")).toBe("disabled");
    expect(host.project("org.example.alpha")).toBeUndefined();
    expect((await host.fetch(req("/fragments/org.example.alpha/x"))).status).toBe(503);
    // And it can be enabled again afterwards.
    await host.enable("org.example.alpha");
    expect(await json(host, "/fragments/org.example.alpha/x")).toMatchObject({ label: "alpha" });
  });
});

// statewalker-root#261: "remove with data" deletes the fragment's data; a plain removal keeps it.
describe("removing a fragment with its data", () => {
  test("deletes <data>/fragments/<id>/; added again, the fragment starts from nothing", async () => {
    const data = tmp("cellb-remove-data-");
    const host = track(createFragmentHost({ data }));
    await host.add("org.example.alpha", ALPHA);
    await json(host, "/fragments/org.example.alpha/x");
    expect(await json(host, "/fragments/org.example.alpha/x")).toMatchObject({ n: 2 });
    expect(existsSync(join(data, "fragments", "org.example.alpha"))).toBe(true);
    await host.remove("org.example.alpha", { withData: true });
    expect(existsSync(join(data, "fragments", "org.example.alpha"))).toBe(false);
    expect(host.state("org.example.alpha")).toBeUndefined();
    await host.add("org.example.alpha", ALPHA);
    expect(await json(host, "/fragments/org.example.alpha/x")).toMatchObject({ n: 1 });
  });

  test("deletes a disabled fragment's data too, and leaves the other fragments' alone", async () => {
    const data = tmp("cellb-remove-data-");
    const host = track(createFragmentHost({ data }));
    await host.add("org.example.alpha", ALPHA);
    await host.add("org.example.beta", BETA);
    await json(host, "/fragments/org.example.alpha/x");
    await json(host, "/fragments/org.example.beta/x");
    await host.disable("org.example.alpha");
    await host.remove("org.example.alpha", { withData: true });
    expect(existsSync(join(data, "fragments", "org.example.alpha"))).toBe(false);
    expect(await json(host, "/fragments/org.example.beta/x")).toMatchObject({ n: 2 });
  });
});

// Merge gate pass 1 on statewalker/cellb.dev#250 (H1, H2). The data directories sit three levels
// inside a fresh temporary directory, so no id could reach outside it even if the check regressed.
describe("remove with data: only the fragment's own data", () => {
  const sandboxed = (prefix: string) => join(tmp(prefix), "a", "b", "c", "data");

  test("refuses ids that are not fragment ids, deleting nothing", async () => {
    const data = sandboxed("cellb-remove-ids-");
    const host = track(createFragmentHost({ data }));
    await host.add("org.example.alpha", ALPHA);
    await json(host, "/fragments/org.example.alpha/x");
    for (const id of ["..", "", "../..", "a/..", "."])
      await expect(host.remove(id, { withData: true }), JSON.stringify(id)).rejects.toThrow(
        /not a fragment id/,
      );
    expect(existsSync(join(data, "fragments", "org.example.alpha"))).toBe(true);
    expect(await json(host, "/fragments/org.example.alpha/x")).toMatchObject({ n: 2 });
  });

  test("an add of the same id during the removal waits for it, and keeps its new data", async () => {
    const data = sandboxed("cellb-remove-race-");
    const host = track(createFragmentHost({ data }));
    await host.add("org.example.alpha", ALPHA);
    await json(host, "/fragments/org.example.alpha/x");
    const removing = host.remove("org.example.alpha", { withData: true });
    const adding = host.add("org.example.alpha", ALPHA);
    await removing;
    await adding;
    expect(await json(host, "/fragments/org.example.alpha/x")).toMatchObject({ n: 1 });
    expect(await json(host, "/fragments/org.example.alpha/x")).toMatchObject({ n: 2 });
  });
});

// #199 (statewalker-root#263, Move): a fragment's data exported on one host and imported on
// another; a hand-over keeps the source from writing until it is reactivated or deleted.
describe("moving a fragment's data between hosts", () => {
  const ID = "org.example.alpha";

  async function counted(host: { fetch(r: Request): Promise<Response> }) {
    return (await json(host, `/fragments/${ID}/x`)).n;
  }

  test("an export imported on a second host continues where the first one stopped", async () => {
    const first = track(createFragmentHost({ data: tmp("cellb-move-a-") }));
    await first.add(ID, ALPHA);
    await counted(first);
    await json(first, `/fragments/${ID}/kv?put=moved`);
    expect(await counted(first)).toBe(2);
    await first.disable(ID);
    const files = await first.exportData(ID, { handOver: { at: "2026-11-27T00:00:00Z", to: "b" } });
    expect(files.map(([p]) => p)).toEqual([...files.map(([p]) => p)].sort());
    expect(files.some(([p]) => p.endsWith(".sqlite"))).toBe(true);
    expect(files.some(([p]) => p.includes("handed-over"))).toBe(false);

    const secondData = tmp("cellb-move-b-");
    const second = track(createFragmentHost({ data: secondData }));
    const report = await second.importData(ID, files);
    expect(report.files).toEqual(files.map(([p]) => p));
    expect(report.bytes).toBe(files.reduce((n, [, b]) => n + b.byteLength, 0));
    await second.add(ID, ALPHA);
    // The same object (idFromName(<id>)) with its data.
    expect(await counted(second)).toBe(3);
    expect(await json(second, `/fragments/${ID}/kv`)).toEqual({ kv: "moved" });
  });

  test("a handed-over source refuses to run until it is reactivated, with its data kept", async () => {
    const data = tmp("cellb-move-src-");
    const host = track(createFragmentHost({ data }));
    await host.add(ID, ALPHA);
    await counted(host);
    await host.disable(ID);
    await host.exportData(ID, {
      handOver: { at: "2026-11-27T00:00:00Z", to: "url:https://b.example" },
    });
    expect(host.handedOver(ID)).toEqual({
      at: "2026-11-27T00:00:00Z",
      to: "url:https://b.example",
    });
    await expect(host.enable(ID)).rejects.toThrow(/handed over to url:https:\/\/b\.example/);
    expect(host.state(ID)).toBe("disabled");
    expect((await host.fetch(req(`/fragments/${ID}/x`))).status).toBe(503);
    // Nor on a host started again over the same directory, nor by loadProject on its folder.
    const again = track(createFragmentHost({ data }));
    await expect(again.add(ID, ALPHA)).rejects.toThrow(/handed over/);
    await expect(loadProject(ALPHA, { data: join(data, "fragments", ID) })).rejects.toThrow(
      /handed over/,
    );
    // Rollback: the source runs again with the data it kept.
    expect(await host.reactivate(ID)).toMatchObject({ id: ID });
    expect(host.handedOver(ID)).toBeUndefined();
    expect(await counted(host)).toBe(2);
  });

  test("removing a handed-over fragment with its data deletes the marker too", async () => {
    const data = tmp("cellb-move-del-");
    const host = track(createFragmentHost({ data }));
    await host.add(ID, ALPHA);
    await counted(host);
    await host.disable(ID);
    await host.exportData(ID, { handOver: true });
    await host.remove(ID, { withData: true });
    expect(host.handedOver(ID)).toBeUndefined();
    await host.add(ID, ALPHA);
    expect(await counted(host)).toBe(1);
  });

  test("refuses a running fragment, a memory host, and ids that are not fragment ids", async () => {
    const host = track(createFragmentHost({ data: tmp("cellb-move-refuse-") }));
    await host.add(ID, ALPHA);
    await expect(host.exportData(ID)).rejects.toThrow(/running: disable it/);
    await expect(host.importData(ID, [])).rejects.toThrow(/running: disable it/);
    for (const id of ["..", "", "a/b"])
      await expect(host.exportData(id), JSON.stringify(id)).rejects.toThrow(/not a fragment id/);
    const memory = track(createFragmentHost());
    await expect(memory.exportData(ID)).rejects.toThrow(/in memory/);
  });

  test("an import refuses existing data unless asked to overwrite, and paths outside the folder", async () => {
    const data = join(tmp("cellb-move-import-"), "a", "b", "data");
    const host = track(createFragmentHost({ data }));
    for (const path of [
      "../x.sqlite",
      "/x.sqlite",
      "a/../../x",
      "",
      "a//b",
      ".cellb-handed-over.json",
    ])
      await expect(host.importData(ID, [[path, new Uint8Array(1)]]), path).rejects.toThrow();
    await expect(
      host.importData(ID, [
        ["x.sqlite", new Uint8Array(1)],
        ["x.sqlite", new Uint8Array(2)],
      ]),
    ).rejects.toThrow(/twice/);
    expect(existsSync(join(data, "fragments", ID))).toBe(false);

    await host.add(ID, ALPHA);
    expect(await counted(host)).toBe(1);
    await host.disable(ID);
    const kept = await host.exportData(ID);
    await expect(host.importData(ID, [["files/x", new Uint8Array(1)]])).rejects.toThrow(
      /already holds data/,
    );
    await host.enable(ID);
    expect(await counted(host)).toBe(2);
    await host.disable(ID);
    // Overwritten with the earlier export: the data is as it was then.
    await host.importData(ID, kept, { overwrite: true });
    await host.enable(ID);
    expect(await counted(host)).toBe(2);
  });
});
