import { afterEach, describe, expect, it, vi } from "vitest";
import { createCellRuntime, DurableObject, type DurableObjectNamespace } from "../src/index.js";
import { nodeSqliteOpener } from "../src/node.js";

// On workerd and celld a promise the Worker leaves rejected is the Worker's affair. On Node the
// Worker shares the host's process; cellb keeps such a rejection the Worker's: it reaches the
// runtime's onUnhandledRejection, never the process's `unhandledRejection` listeners.

/** Rejects without a handler (as `assert.rejects(…)` left unawaited does). */
const leaveRejected = (what: string) => {
  void Promise.reject(new Error(what));
};

class Leaky extends DurableObject {
  leak(what: string) {
    leaveRejected(what);
    return "done";
  }
}

const settle = () => new Promise((r) => setTimeout(r, 20));

let processSaw: unknown[] = [];
const onProcess = (reason: unknown) => processSaw.push(reason);
afterEach(() => {
  process.off("unhandledRejection", onProcess);
  processSaw = [];
});

describe("P20 a Worker's unhandled rejections are the Worker's", () => {
  it("from a fetch, a Durable Object method and a cron-style event, to the runtime only", async () => {
    process.on("unhandledRejection", onProcess);
    const seen: string[] = [];
    const runtime = createCellRuntime({
      worker: {
        Leaky,
        default: {
          async fetch() {
            leaveRejected("from fetch");
            await null;
            leaveRejected("from fetch, after an await");
            return new Response("ok");
          },
        },
      },
      durableObjects: { LEAKY: { className: "Leaky" } },
      openSql: nodeSqliteOpener(),
      onUnhandledRejection: (reason) => seen.push((reason as Error).message),
    });
    try {
      expect(await (await runtime.fetch(new Request("http://x/"))).text()).toBe("ok");
      const ns = runtime.env.LEAKY as DurableObjectNamespace;
      expect(await (ns.getByName("a") as unknown as Leaky).leak("from an object")).toBe("done");
      runtime.runEvent(() => leaveRejected("from a host-dispatched event"));
      await settle();
      expect(seen.sort()).toEqual([
        "from a host-dispatched event",
        "from an object",
        "from fetch",
        "from fetch, after an await",
      ]);
      expect(processSaw).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it("the host's own rejections still reach the process", async () => {
    process.on("unhandledRejection", onProcess);
    const runtime = createCellRuntime({
      worker: { default: { fetch: () => new Response("ok") } },
      openSql: nodeSqliteOpener(),
      onUnhandledRejection: () => {
        throw new Error("not the Worker's");
      },
    });
    try {
      await runtime.fetch(new Request("http://x/"));
      leaveRejected("from the host");
      await settle();
      expect(processSaw.map((r) => (r as Error).message)).toEqual(["from the host"]);
    } finally {
      await runtime.close();
    }
  });

  it("by default, one line on stderr naming the script, not the Worker's console", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = vi.spyOn(console, "error");
    const runtime = createCellRuntime({
      scriptName: "leaky-script",
      worker: {
        default: {
          fetch() {
            leaveRejected("lost");
            return new Response("ok");
          },
        },
      },
      openSql: nodeSqliteOpener(),
    });
    try {
      await runtime.fetch(new Request("http://x/"));
      await settle();
      const lines = write.mock.calls.map((c) => String(c[0]));
      expect(
        lines.some((l) =>
          l.startsWith("[cellb] leaky-script: unhandled rejection in Worker code: Error: lost"),
        ),
      ).toBe(true);
      expect(log).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      log.mockRestore();
      await runtime.close();
    }
  });
});
