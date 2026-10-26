import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { bundleWorkerForBrowser } from "../src/node.ts";

// What the Agents SDK (and Flue, built on it) needs from a browser host, in one project:
// `env` and `exports` of cloudflare:workers, cloudflare:email, and the nodejs_compat modules it
// imports (packages/flue-example runs a whole Flue app the same way).
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
