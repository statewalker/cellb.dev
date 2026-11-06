import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebSocketClass, filesApiLtxLog, type ProjectRuntime } from "../src/index.js";
import { loadNodeProject, nodeSqliteOpener } from "../src/node.js";
import { partyProjectDir } from "./partyserver/fixture.js";

// partyserver (cloudflare/partykit) on cellb, unchanged: a party room, partywhen's scheduler,
// and an extension whose partyserver Server is loaded at run time (Worker Loader) and runs as a
// facet, over HTTP and WebSockets (test/partyserver).
describe("P36 partyserver", () => {
  let dir: string;
  const log = new MemFilesApi();
  let node = 0;
  /** A node of the project; each has its own SQLite files and restores from the shared log. */
  const start = async () =>
    (
      await loadNodeProject(dir, {
        openSql: nodeSqliteOpener(mkdtempSync(join(tmpdir(), "party-sql-"))),
        files: new MemFilesApi(),
        storage: filesApiLtxLog(log, { epoch: ++node }),
      })
    ).runtime;
  let runtime: ProjectRuntime["runtime"];
  const get = async (path: string) =>
    (await runtime.fetch(new Request(`http://party${path}`))).json();
  const socket = (path: string) =>
    new Promise<{ inbox: string[]; send(m: string): void; close(): void }>((resolve, reject) => {
      const WS = createWebSocketClass((url, p) => runtime.connectWebSocket(url, p));
      const ws = new WS(`ws://party${path}`);
      const inbox: string[] = [];
      ws.onmessage = (e: MessageEvent) => inbox.push(String(e.data));
      ws.onerror = () => reject(new Error(`socket ${path} failed`));
      ws.onopen = () => resolve({ inbox, send: (m) => ws.send(m), close: () => ws.close() });
    });
  const until = async (check: () => boolean, ms = 5_000) => {
    for (const end = Date.now() + ms; !check() && Date.now() < end; )
      await new Promise((r) => setTimeout(r, 20));
  };

  beforeAll(async () => {
    dir = await partyProjectDir();
    runtime = await start();
  }, 60_000);
  afterAll(() => runtime.close());

  it("a room broadcasts to every socket and keeps its count", async () => {
    const a = await socket("/parties/room/lobby");
    const b = await socket("/parties/room/lobby");
    a.send("hi");
    await until(() => b.inbox.length === 2);
    expect(b.inbox).toEqual([
      JSON.stringify({ room: "lobby", n: 0 }),
      JSON.stringify({ room: "lobby", n: 1, msg: "hi" }),
    ]);
    a.close();
    b.close();
    expect(await get("/parties/room/lobby")).toMatchObject({ room: "lobby", n: 1 });
  });

  it("partywhen runs a delayed task on the room", async () => {
    await runtime.fetch(new Request("http://party/schedule"));
    let ticks = 0;
    await until(() => ticks === 1, 10_000);
    for (const end = Date.now() + 10_000; Date.now() < end; ) {
      ticks = ((await get("/parties/room/lobby")) as { ticks: number }).ticks;
      if (ticks) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(ticks).toBe(1);
  }, 20_000);

  it("a loaded extension's Server runs as a facet, under its own id's name", async () => {
    expect(await get("/ext/notes")).toEqual({ plugin: "facet:notes", activations: 1 });
    expect(await get("/ext/todo")).toEqual({ plugin: "facet:todo", activations: 1 });
  });

  it("a WebSocket reaches the loaded extension", async () => {
    const s = await socket("/ext/notes");
    s.send("ping");
    await until(() => s.inbox.length === 2);
    expect(s.inbox).toEqual([
      JSON.stringify({ plugin: "facet:notes", hello: true }),
      JSON.stringify({ plugin: "facet:notes", echo: "ping" }),
    ]);
    s.close();
  });

  it("a fresh node continues the room and activates the extension from its storage", async () => {
    await runtime.close();
    runtime = await start();
    expect(await get("/parties/room/lobby")).toMatchObject({ n: 1, ticks: 1 });
    expect(await get("/ext/notes")).toEqual({ plugin: "facet:notes", activations: 2 });
  }, 30_000);
});
