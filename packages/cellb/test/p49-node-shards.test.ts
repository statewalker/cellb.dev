import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { startProjectShards } from "../src/node.js";

// startProjectShards on Node (statewalker/cellb.dev#186): one project over worker threads, a port
// between every two threads, each object in the thread shardOf gives it.
const dir = resolve(import.meta.dirname, "fixtures/node-shards");
type Hit = { n: number; thread: number };
const hit = async (app: { fetch(r: Request): Promise<Response> }, q: string) =>
  (await (await app.fetch(new Request(`http://x/?${q}`))).json()) as Hit & {
    me: number;
    other: number;
  };
const names = Array.from({ length: 12 }, (_, i) => `n${i}`);

describe("P49 startProjectShards on Node", () => {
  it("every object lives in one thread, whichever thread a request enters", async () => {
    const app = await startProjectShards({ shards: 3, dir });
    try {
      const seen = new Map<string, Hit[]>();
      for (let round = 0; round < 3; round++)
        for (const name of names) {
          const r = await hit(app, `name=${name}`); // ingress goes round robin over the threads
          seen.set(name, [...(seen.get(name) ?? []), r]);
        }
      for (const [name, hits] of seen) {
        expect([name, hits.map((h) => h.n)]).toEqual([name, [1, 2, 3]]);
        expect([name, new Set(hits.map((h) => h.thread)).size]).toEqual([name, 1]);
      }
      const threads = new Set([...seen.values()].map((h) => h[0].thread));
      expect(threads.size).toBe(3);
    } finally {
      await app.close();
    }
  });

  it("a Durable Object calls another in a different thread", async () => {
    const app = await startProjectShards({ shards: 3, dir });
    try {
      const threadOf = new Map<string, number>();
      for (const name of names) threadOf.set(name, (await hit(app, `name=${name}`)).thread);
      const [a] = names;
      const b = names.find((n) => threadOf.get(n) !== threadOf.get(a))!;
      const r = await hit(app, `name=${a}&bump=${b}`);
      expect(r.me).toBe(threadOf.get(a));
      expect(r.other).toBe(threadOf.get(b));
      expect(r.n).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("with the main thread's FilesApi, cells reopen with another thread count", async () => {
    const files = new MemFilesApi();
    const first = await startProjectShards({
      shards: 2,
      dir,
      data: mkdtempSync(join(tmpdir(), "p49-a-")),
      files,
    });
    try {
      for (const name of names) expect((await hit(first, `name=${name}`)).n).toBe(1);
      for (const name of names) expect((await hit(first, `name=${name}`)).n).toBe(2);
    } finally {
      await first.close();
    }
    let ltx = 0;
    for await (const e of files.list("/", { recursive: true }))
      if (e.kind === "file" && e.path.endsWith(".ltx")) ltx++;
    expect(ltx).toBeGreaterThan(0);
    // Three threads with empty data directories: the cells come back from the FilesApi alone.
    const second = await startProjectShards({
      shards: 3,
      dir,
      data: mkdtempSync(join(tmpdir(), "p49-b-")),
      files,
    });
    try {
      for (const name of names) expect((await hit(second, `name=${name}`)).n).toBe(3);
    } finally {
      await second.close();
    }
  });
});
