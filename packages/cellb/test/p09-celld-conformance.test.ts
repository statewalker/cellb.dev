import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { createWebSocketClass, memoryObjectStore, type ObjectStore } from "../src/index.js";
import { loadNodeProject, nodeSqliteOpener } from "../src/node.js";
import { startReferenceServer } from "./ws-reference-server.js";

// celld's own examples, unchanged, from their own wrangler.jsonc, must answer exactly as
// the real celld 0.6.3 answered (conformance/golden, recorded by conformance/record-celld.ts).
const golden = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, `../conformance/golden/${name}.json`), "utf8"));

async function target(
  name: string,
  bucketStore?: ObjectStore,
): Promise<Target & { unsupported: string[] }> {
  const { runtime, unsupported } = await loadNodeProject(projectDir(name), {
    openSql: nodeSqliteOpener(),
    files: new MemFilesApi(),
    storage: { objects: bucketStore },
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

// The scenarios run 4 at a time, so cron's 65 s overlaps the rest. Each has its own runtime
// (in-memory SQLite and files); what user code logs goes to the scenario whose async context
// logged it (cell_console lines, as celld prints them).
vi.setConfig({ maxConcurrency: 4 });
const scenarioLogs = new AsyncLocalStorage<string[]>();
const methods = ["log", "info", "warn", "error", "debug"] as const;
const originals = methods.map((m) => console[m]);
beforeAll(() => {
  for (const [i, m] of methods.entries())
    console[m] = (...args: unknown[]) => {
      const logs = scenarioLogs.getStore();
      if (logs) logs.push(formatLog(args));
      else originals[i](...args);
    };
});
afterAll(() => {
  for (const [i, m] of methods.entries()) console[m] = originals[i];
});

describe.concurrent("P09 celld examples on webrun-cells (Node) vs recorded celld 0.6.3", () => {
  // The R2 projects once more with objects in celld's bucket layout (r2-celld.ts): the same
  // answers whichever store R2 uses.
  for (const name of Object.keys(scenarios).filter((n) => n.startsWith("r2")))
    it(`${name} — R2 in celld's bucket layout`, async () => {
      const t = await target(name, memoryObjectStore());
      const transcript = await runScenario(t, scenarios[name]);
      const expected = golden(name);
      expect(alignDocumentedDifferences(transcript, expected.transcript)).toEqual(
        expected.transcript,
      );
    }, 30_000);
  for (const name of Object.keys(scenarios)) {
    const scenario = scenarios[name];
    const wait =
      (scenario.settleMs ?? 1500) +
      scenario.steps.reduce((n, s) => n + ("waitMs" in s ? s.waitMs : 0), 0);
    (scenario.knownGap ? it.fails : it)(
      scenario.knownGap ? `${name} — known gap: ${scenario.knownGap}` : name,
      async () => {
        const expected = golden(name);
        const ref = scenario.wsServer ? await startReferenceServer() : undefined;
        const logs: string[] = [];
        try {
          const transcript = await scenarioLogs.run(logs, async () => {
            const t = await target(name);
            t.wsServer = ref ? `ws://127.0.0.1:${ref.port}` : undefined;
            return Promise.race([
              runScenario(t, scenario),
              new Promise<never>((_, rej) =>
                setTimeout(() => rej(new Error("scenario timed out")), wait + 15_000),
              ),
            ]);
          });
          expect(alignDocumentedDifferences(transcript, expected.transcript)).toEqual(
            expected.transcript,
          );
          if (expected.logs) {
            await new Promise((r) => setTimeout(r, scenario.settleMs ?? 1500));
            expect(normalizeLogs(logs, scenario)).toEqual(expected.logs);
          }
        } finally {
          await ref?.close();
        }
      },
      wait + 30_000,
    );
  }
});
