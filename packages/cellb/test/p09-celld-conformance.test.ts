import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { projectDir, runScenario, scenarios, type Target } from "../conformance/scenarios.js";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { createWebSocketClass } from "../src/index.js";
import { loadNodeProject } from "../src/project/node-project.js";

// celld's own examples, unchanged, from their own wrangler.jsonc, must answer exactly as
// the real celld 0.6.2 answered (conformance/golden, recorded by conformance/record-celld.ts).
const golden = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, `../conformance/golden/${name}.json`), "utf8"));

async function target(name: string): Promise<Target & { unsupported: string[] }> {
  const { runtime, unsupported } = await loadNodeProject(projectDir(name), {
    openSql: nodeSqliteOpener(),
    files: new MemFilesApi(),
  });
  const WS = createWebSocketClass((url, p) => runtime.connectWebSocket(url, p));
  return {
    unsupported,
    origin: "http://127.0.0.1:18701",
    fetch: (req) => runtime.fetch(req),
    websocket: (url) =>
      new Promise((resolve, reject) => {
        const ws = new WS(url);
        const queue: unknown[] = [];
        const waiters: ((v: unknown) => void)[] = [];
        ws.onmessage = (e: MessageEvent) =>
          waiters.length ? waiters.shift()!(e.data) : queue.push(e.data);
        ws.onerror = () => reject(new Error("websocket error"));
        ws.onopen = () =>
          resolve({
            send: (m: string) => ws.send(m),
            next: () =>
              queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)),
            close: () => ws.close(),
          });
      }),
  };
}

/**
 * Documented difference, not hidden: celld 0.6.2 sends NO Content-Type for
 * `new Response("text")`, while the Fetch standard (browsers, Node, workerd) sets
 * "text/plain;charset=UTF-8". Only that exact pair is aligned.
 */
function alignDocumentedDifferences(ours: any[], theirs: any[]): any[] {
  return ours.map((e, i) =>
    theirs[i]?.contentType === null && e.contentType === "text/plain;charset=UTF-8"
      ? { ...e, contentType: null }
      : e,
  );
}

describe("P09 celld examples on webrun-cells (Node) vs recorded celld 0.6.2", () => {
  for (const name of Object.keys(scenarios)) {
    it(name, async () => {
      const t = await target(name);
      const transcript = await Promise.race([
        runScenario(t, scenarios[name]),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("scenario timed out")), 12_000),
        ),
      ]);
      expect(alignDocumentedDifferences(transcript, golden(name).transcript)).toEqual(
        golden(name).transcript,
      );
    }, 20_000);
  }
});
