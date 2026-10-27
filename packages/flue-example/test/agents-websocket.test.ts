import { copyFileSync, mkdtempSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebSocketClass } from "@statewalker/cellb";
import { loadNodeProject, nodeSqliteOpener } from "@statewalker/cellb/node";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const app = join(import.meta.dirname, "agents");

/** The app as wrangler bundles it (workerd's export conditions), ready for cellb to load. */
async function deployment(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "agents-chat-"));
  await build({
    entryPoints: [join(app, "chat-agent.ts")],
    outfile: join(dir, "index.js"),
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*", ...builtinModules], // nodejs_compat
    logLevel: "silent",
  });
  copyFileSync(join(app, "wrangler.json"), join(dir, "wrangler.json"));
  return dir;
}

// The Agents SDK's own WebSocket path (partyserver: accept, attachments, broadcast) on cellb.
describe("an Agents SDK app's WebSockets on cellb", () => {
  it("runs onConnect and onMessage, keeps each connection's state, broadcasts to all", async () => {
    const { runtime, unsupported } = await loadNodeProject(await deployment(), {
      openSql: nodeSqliteOpener(),
      files: new MemFilesApi(),
    });
    try {
      expect(unsupported).toEqual([]);
      const WS = createWebSocketClass((url, protocols) => runtime.connectWebSocket(url, protocols));
      const connect = async (user: string) => {
        const ws = new WS(`ws://app.test/agents/chat-agent/room-1?user=${user}`);
        const inbox: string[] = [];
        let arrived = () => {};
        ws.addEventListener("message", (e) => {
          const text = String((e as MessageEvent).data);
          // The Agents SDK also sends its own JSON frames (identity, state, MCP servers).
          if (text.startsWith("{")) return;
          inbox.push(text);
          arrived();
        });
        /** Resolves once the inbox holds `n` chat messages. */
        const received = (n: number) =>
          new Promise<void>((r) => {
            arrived = () => inbox.length >= n && r();
            arrived();
          });
        await new Promise((r, j) => {
          ws.addEventListener("open", r, { once: true });
          ws.addEventListener("error", j, { once: true });
        });
        return { ws, inbox, received };
      };
      const ann = await connect("ann");
      const bob = await connect("bob");
      await Promise.all([ann.received(1), bob.received(1)]);
      ann.ws.send("hi");
      await bob.received(2);
      bob.ws.send("hello");
      await Promise.all([ann.received(3), bob.received(3)]);
      expect(ann.inbox).toEqual(["welcome ann", "ann: hi", "bob: hello"]);
      expect(bob.inbox).toEqual(["welcome bob", "ann: hi", "bob: hello"]);
      ann.ws.close();
      bob.ws.close();
    } finally {
      await runtime.close();
    }
  }, 30_000); // bundling the SDK takes a few seconds on a busy machine
});
