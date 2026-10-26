/// <reference lib="webworker" />
// Hosts the Flue app (bundled on the Node side by bundleWorkerForBrowser) in this Dedicated
// Worker and talks to it with Flue's own client, through the runtime's fetch.

import { createFlueClient } from "@flue/sdk";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { WranglerConfig } from "@statewalker/cellb";
import { browserProjectRuntime } from "@statewalker/cellb/browser";

interface Job {
  config: WranglerConfig;
  bundle: string;
  run: string;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (e) => {
  const reply = (v: unknown) => (e.ports[0] as MessagePort).postMessage(v);
  try {
    reply({ ok: true, ...(await runScenario(e.data as Job)) });
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};

// What the app logs as warnings and errors (a failed submission, a broken object) comes back
// with the result: the test expects none.
const problems: string[] = [];
for (const level of ["warn", "error"] as const) {
  const real = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    problems.push(
      `${level}: ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" ")}`,
    );
    real(...args);
  };
}

async function runScenario({ config, bundle, run }: Job) {
  const sqlite3 = await (sqlite3InitModule as any)({ print() {}, printErr() {} });
  // The same OPFS pool and files directory for both hosts: the second one is a page reload.
  const start = () =>
    browserProjectRuntime({
      config,
      code: { bundle },
      sqlite3,
      pool: `flue-${run}`,
      filesDir: `flue-files-${run}`,
    });
  const host = await start();
  const client = (runtime: typeof host.runtime, id: string) =>
    createFlueClient({
      url: `http://app.test/agents/assistant/${id}`,
      fetch: (input, init) => runtime.fetch(new Request(input, init)),
    });

  const ping = await (await host.runtime.fetch(new Request("http://app.test/ping"))).text();

  // 1. One conversation: admission, the alarm-driven run, a tool call, the reply.
  const one = client(host.runtime, "conv-1");
  const admission = await one.send({ message: { kind: "user", body: "What is the answer?" } });
  const reply = await one.read(admission);
  const roles = (await one.history()).messages.map((m) => m.role);

  // 2. A reply followed live over SSE.
  const live = client(host.runtime, "conv-live");
  await live.send({ message: { kind: "user", body: "live?" } });
  const phases: string[] = [];
  const liveReply = await new Promise<string>((resolve, reject) => {
    const observation = live.observe({ live: "sse" });
    const timer = setTimeout(() => reject(new Error(`no live reply: ${phases}`)), 30_000);
    observation.subscribe(() => {
      const { conversation, phase, error } = observation.getSnapshot();
      phases.push(phase);
      if (phase === "error") reject(error);
      const settled = conversation?.settlements.some((x) => x.outcome === "completed");
      if (settled) {
        clearTimeout(timer);
        resolve(JSON.stringify(conversation?.messages.at(-1)));
        observation.close();
      }
    });
  });

  // 3. Two conversations at once (AsyncLocalStorage is one store at a time in a browser).
  const a = client(host.runtime, "conv-a");
  const b = client(host.runtime, "conv-b");
  const [sa, sb] = await Promise.all([
    a.send({ message: { kind: "user", body: "question-a" } }),
    b.send({ message: { kind: "user", body: "question-b" } }),
  ]);
  const concurrent = await Promise.allSettled([a.read(sa), b.read(sb)]);
  // Each conversation's stored messages, as text: a context mixed up between the two
  // conversations would put one's messages into the other's Durable Object.
  const texts = async (c: ReturnType<typeof client>) =>
    (await c.history()).messages.map(
      (m) => `${m.role}: ${JSON.stringify(m.parts.filter((p) => p.type === "text"))}`,
    );
  const histories = { a: await texts(a), b: await texts(b) };

  await host.close();

  // 4. A reload: a new runtime on the same OPFS pool reads the stored conversation back.
  const again = await start();
  const reloaded = (await client(again.runtime, "conv-1").history()).messages.map((m) => m.role);
  await again.close();

  return {
    unsupported: host.unsupported,
    ping,
    reply: reply.text,
    roles,
    liveReply,
    sawLive: phases.includes("live"),
    concurrent: concurrent.map((r) =>
      r.status === "fulfilled" ? { text: r.value.text } : { error: String(r.reason) },
    ),
    histories,
    reloaded,
    problems,
  };
}
