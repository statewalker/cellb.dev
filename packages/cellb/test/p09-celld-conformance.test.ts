import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { projectDir } from "../conformance/projects.js";
import {
  alignDocumentedDifferences,
  formatLog,
  normalizeLogs,
  runScenario,
  scenarios,
  type Target,
  withContentLength,
} from "../conformance/scenarios.js";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { createWebSocketClass } from "../src/index.js";
import { loadNodeProject } from "../src/project/node-project.js";
import { startReferenceServer } from "./ws-reference-server.js";

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
    fetch: async (req) => withContentLength(req, await runtime.fetch(req)),
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

describe("P09 celld examples on webrun-cells (Node) vs recorded celld 0.6.2", () => {
  for (const name of Object.keys(scenarios)) {
    const scenario = scenarios[name];
    const wait =
      (scenario.settleMs ?? 1500) +
      scenario.steps.reduce((n, s) => n + ("waitMs" in s ? s.waitMs : 0), 0);
    it(
      name,
      async () => {
        const expected = golden(name);
        const ref = scenario.wsServer ? await startReferenceServer() : undefined;
        // User logs, formatted as celld prints them (cell_console lines).
        const logs: string[] = [];
        const methods = ["log", "info", "warn", "error", "debug"] as const;
        const originals = methods.map((m) => console[m]);
        for (const m of methods)
          console[m] = (...args: unknown[]) => void logs.push(formatLog(args));
        try {
          const t = await target(name);
          t.wsServer = ref ? `ws://127.0.0.1:${ref.port}` : undefined;
          const transcript = await Promise.race([
            runScenario(t, scenario),
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error("scenario timed out")), wait + 15_000),
            ),
          ]);
          expect(alignDocumentedDifferences(transcript, expected.transcript)).toEqual(
            expected.transcript,
          );
          if (expected.logs) {
            await new Promise((r) => setTimeout(r, scenario.settleMs ?? 1500));
            expect(normalizeLogs(logs, scenario)).toEqual(expected.logs);
          }
        } finally {
          for (const [i, m] of methods.entries()) console[m] = originals[i];
          await ref?.close();
        }
      },
      wait + 30_000,
    );
  }
});
