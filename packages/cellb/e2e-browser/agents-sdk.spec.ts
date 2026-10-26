import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { bundleProjectForBrowser } from "../conformance/browser-bundle.ts";
import type { Scenario } from "../conformance/scenarios.ts";

// A Cloudflare Agents SDK app (e2e-browser/fixtures/agents-app) run by cellb in a browser
// worker. Agents SDK apps do not run on celld, so this is not a recorded scenario.
const state = JSON.stringify({ type: "cf_agent_state", state: { topic: "answers" } });
const scenario: Scenario = {
  steps: [
    // Two agents answer at once, each awaiting: AsyncLocalStorage keeps them apart.
    { path: "/context" },
    // partyserver recognises its sockets: identity and MCP servers on connect; a state sent
    // on one connection is stored, and the next connection starts with it.
    { ws: "/agents/echo/room", send: [state], receive: 2 },
    { ws: "/agents/echo/room", send: [], receive: 3 },
  ],
};

test("an Agents SDK app runs in a browser", async ({ page }) => {
  const project = await bundleProjectForBrowser(
    "agents-app",
    join(import.meta.dirname, "fixtures/agents-app"),
  );
  await page.goto("/projects/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const r = await page.evaluate((job) => (window as any).__runProject(job), { project, scenario });
  expect(r.ok, r.error).toBe(true);
  const [context, first, second] = r.transcript;
  expect(context.body).toEqual([
    { name: "a", current: "a" },
    { name: "b", current: "b" },
  ]);
  expect(first.messages.map((m: { type: string }) => m.type)).toEqual([
    "cf_agent_identity",
    "cf_agent_mcp_servers",
  ]);
  expect(second.messages).toContainEqual({ type: "cf_agent_state", state: { topic: "answers" } });
});
