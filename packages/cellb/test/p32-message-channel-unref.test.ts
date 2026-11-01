import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { loadNodeProject, nodeSqliteOpener } from "../src/node.js";
import { WorkerdMessageChannel } from "../src/project/workerd-message-channel.js";

/** Ports that keep this Node process alive. */
const heldPorts = () => process.getActiveResourcesInfo().filter((r) => r === "MessagePort").length;
const turn = () => new Promise((r) => setTimeout(r, 20));

// In workerd an open port keeps nothing alive; on Node a port with a handler holds the event
// loop. Libraries keep such a port at module scope (React DOM's server renderer schedules its
// work over one): a Worker importing them must not keep the Node host alive once closed.
describe("P32 workerd's MessageChannel on a Node host", () => {
  it("holds the loop only while a message waits for its handler", async () => {
    const Channel = WorkerdMessageChannel as typeof MessageChannel;
    const base = heldPorts();
    const { port1, port2 } = new Channel();
    const got: unknown[] = [];
    port1.onmessage = (e) => got.push(e.data);
    expect(heldPorts()).toBe(base);
    port2.postMessage("a");
    port2.postMessage("b");
    expect(heldPorts()).toBe(base + 1);
    await turn();
    expect(got).toEqual(["a", "b"]);
    expect(heldPorts()).toBe(base);

    // Listeners (with start()) and the other direction.
    const back: unknown[] = [];
    const listener = (e: Event) => back.push((e as MessageEvent).data);
    port2.addEventListener("message", listener);
    port2.start();
    expect(heldPorts()).toBe(base);
    port1.postMessage("c");
    await turn();
    expect(back).toEqual(["c"]);
    expect(heldPorts()).toBe(base);

    // A message posted before any handler waits, unheld, then is delivered to a later one.
    port2.removeEventListener("message", listener);
    port1.postMessage("d");
    await turn();
    expect(heldPorts()).toBe(base);
    port2.onmessage = (e) => back.push(e.data);
    await turn();
    expect(back).toEqual(["c", "d"]);
    expect(heldPorts()).toBe(base);

    port1.close();
    port2.close();
  });

  it("a Worker scheduling over a module-scope port leaves no held port after close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p32-"));
    writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({ name: "w", main: "index.js" }));
    writeFileSync(
      join(dir, "index.js"),
      [
        "const queue = [];",
        "const channel = new MessageChannel();",
        "channel.port1.onmessage = () => { for (const f of queue.splice(0)) f(); };",
        "const later = () => new Promise((r) => { queue.push(r); channel.port2.postMessage(null); });",
        "export default { async fetch() { await later(); await later(); return new Response('scheduled'); } };",
      ].join("\n"),
    );
    const base = heldPorts();
    const { runtime } = await loadNodeProject(dir, {
      openSql: nodeSqliteOpener(),
      files: new MemFilesApi(),
    });
    try {
      const res = await runtime.fetch(new Request("http://localhost/"));
      expect(await res.text()).toBe("scheduled");
    } finally {
      await runtime.close();
    }
    await turn();
    expect(heldPorts()).toBe(base);
  });
});
