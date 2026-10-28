import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { bundleWorkerForBrowser } from "../src/node.ts";
import {
  AGENTS_WEBSOCKET_CONFIG,
  AGENTS_WEBSOCKET_WORKER,
  EXPECTED_GLOBALS,
} from "../test/agents-websocket-worker.ts";
import {
  ASYNC_CONTEXT_CONFIG,
  ASYNC_CONTEXT_WORKER,
  expectedSeen,
} from "../test/async-context-worker.ts";
import {
  EXPECTED_LOADED_SCOPE,
  LOADED_SCOPE_CONFIG,
  LOADED_SCOPE_WORKER,
} from "../test/loaded-scope-worker.ts";

// What the Agents SDK (and Flue, built on it) needs from a browser host, in one project:
// `env` and `exports` of cloudflare:workers, cloudflare:email, and the nodejs_compat modules it
// imports (examples/flue runs a whole Flue app the same way).
const worker = `
import { DurableObject, env, exports } from "cloudflare:workers";
import { EmailMessage } from "cloudflare:email";
import { channel } from "node:diagnostics_channel";
import { EOL } from "node:os";
import { readFileSync } from "node:fs";
import path from "path";
const atLoad = env.GREETING; // read while the module is evaluated, as Flue's entry does
const events = channel("test:events");
const seen = [];
events.subscribe((m) => seen.push(m));
export class Box extends DurableObject { hi() { events.publish("hi"); return "box " + env.GREETING; } }
export default {
  async fetch() {
    let email, fs;
    try { new EmailMessage("a@x", "b@x", "raw"); email = "built"; } catch (e) { email = e.message; }
    try { readFileSync("/proc/self/environ", "utf-8"); fs = "read"; } catch (e) { fs = e.code; }
    return Response.json({
      atLoad,
      viaEnv: await env.BOX.getByName("a").hi(),
      viaExports: await exports.Box.getByName("a").hi(),
      seen: seen.length,
      eol: EOL,
      join: path.join("a", "b"),
      email,
      fs,
    });
  },
};
`;

test("a project gets env, exports, cloudflare:email and the Agents SDK's node modules", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "agents-host-"));
  writeFileSync(join(dir, "index.js"), worker);
  const config = {
    name: "agents-host",
    main: "index.js",
    compatibility_flags: ["nodejs_compat"],
    vars: { GREETING: "hello" },
    durable_objects: { bindings: [{ name: "BOX", class_name: "Box" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Box"] }],
  };
  const code = await bundleWorkerForBrowser(join(dir, "index.js"), { nodeCompat: true });
  await page.goto("/entry/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const r = await page.evaluate((p) => (window as any).__runProject(p), { config, code });
  expect(r.ok, r.error).toBe(true);
  expect(r.counts[0]).toEqual({
    atLoad: "hello",
    viaEnv: "box hello",
    viaExports: "box hello",
    seen: 2,
    eol: "\n",
    join: "a/b",
    email: "cloudflare:email is not supported by cellb",
    fs: "ENOENT",
  });
});

// node:async_hooks in a browser: the same answers as Node's (test/p13), with 16 objects at once.
test("AsyncLocalStorage keeps each concurrent object's store, as on Node", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "agents-als-"));
  writeFileSync(join(dir, "index.js"), ASYNC_CONTEXT_WORKER);
  const code = await bundleWorkerForBrowser(join(dir, "index.js"), { nodeCompat: true });
  await page.goto("/entry/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const r = await page.evaluate((p) => (window as any).__runProject(p), {
    config: ASYNC_CONTEXT_CONFIG,
    code,
  });
  expect(r.ok, r.error).toBe(true);
  // The entry page fetches twice: both runs of 16 objects at once.
  for (const run of r.counts) {
    expect(run.outside).toBeNull();
    for (const [name, seen] of Object.entries(run.results))
      expect(seen).toEqual(expectedSeen(name));
  }
});

// The global WebSocket of a browser bundle is workerd's, as the Agents SDK reads it (test/p13
// runs the same Worker on Node, with real sockets).
test("the global WebSocket is workerd's: attachments, READY_STATE_*, one class", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "agents-ws-"));
  writeFileSync(join(dir, "index.js"), AGENTS_WEBSOCKET_WORKER);
  const code = await bundleWorkerForBrowser(join(dir, "index.js"));
  await page.goto("/entry/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const r = await page.evaluate((p) => (window as any).__runProject(p), {
    config: AGENTS_WEBSOCKET_CONFIG,
    code,
  });
  expect(r.ok, r.error).toBe(true);
  expect(r.counts).toEqual([EXPECTED_GLOBALS, EXPECTED_GLOBALS]);
});

// Loaded Workers read their own env and exports, as on Node (test/p13).
for (const isolated of [false, true])
  test(`a loaded Worker gets its own env and exports${isolated ? ", in its own worker" : ""}`, async ({
    page,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "agents-loaded-"));
    writeFileSync(join(dir, "index.js"), LOADED_SCOPE_WORKER);
    const code = await bundleWorkerForBrowser(join(dir, "index.js"));
    await page.goto("/entry/");
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    const r = await page.evaluate((p) => (window as any).__runProject(p), {
      config: LOADED_SCOPE_CONFIG,
      code,
      isolated,
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.counts[0]).toEqual(EXPECTED_LOADED_SCOPE);
  });
