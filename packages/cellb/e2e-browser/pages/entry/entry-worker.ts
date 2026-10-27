/// <reference lib="webworker" />
// A project bundled on the Node side, run through the package's browser entry point alone.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { WranglerConfig } from "@statewalker/cellb";
import { browserProjectRuntime } from "@statewalker/cellb/browser";
import isolateWorker from "@statewalker/cellb/isolate-worker?worker&url";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (e) => {
  const reply = (v: unknown) => (e.ports[0] as MessagePort).postMessage(v);
  // `isolated`: loaded Workers run in Dedicated Workers of their own.
  const project = e.data as { config: WranglerConfig; code: string | null; isolated?: boolean };
  try {
    const run = Date.now().toString(36);
    const host = await browserProjectRuntime({
      config: project.config,
      code: { bundle: project.code },
      sqlite3: await (sqlite3InitModule as any)({ print() {}, printErr() {} }),
      pool: `entry-${run}`,
      filesDir: `entry-files-${run}`,
      isolateScript: project.isolated ? new URL(isolateWorker, import.meta.url) : undefined,
    });
    const counts: unknown[] = [];
    for (let i = 0; i < 2; i++)
      counts.push(await (await host.runtime.fetch(new Request("http://browser/"))).json());
    await host.close();
    reply({ ok: true, counts });
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
