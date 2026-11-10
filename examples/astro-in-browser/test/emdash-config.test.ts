import { join } from "node:path";
import { npmPackages } from "@statewalker/webrun-bundler";
import * as esbuild from "esbuild-wasm";
import { expect, it } from "vitest";
import { preloadVfs, runAstroConfig } from "../src/builder/integrations.ts";
import { appFiles } from "./load-app.ts";

it("runs EmDash's astro.config.mjs and its integrations at build time", async () => {
  const files = await appFiles(join(import.meta.dirname, "../../emdash"));
  const packages = npmPackages();
  const { vfs } = await preloadVfs(files, "/app", packages, [
    ["emdash"],
    ["@emdash-cms/admin", "emdash"],
    ["astro"],
  ]);
  console.log("vfs files", vfs.size);
  const logged: string[] = [];
  const r = await runAstroConfig({
    esbuild,
    files,
    root: "/app",
    packages,
    vfs,
    // The driver the build supplies, set before the integrations run: no warning from EmDash.
    session: { driver: "unstorage/drivers/cloudflare-kv-binding", options: { binding: "SESSION" } },
    evaluate: (code) =>
      import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`),
    log: (m) => (logged.push(m), console.log(m)),
  });
  expect(logged.filter((m) => /session driver/i.test(m))).toEqual([]);
  console.log(
    "routes",
    r.routes.length,
    r.routes[0],
    "mw",
    r.middleware.map((m) => m.entrypoint),
    "plugins",
    r.plugins.map((p) => p.name),
    "renderers",
    r.renderers.map((x) => x.name),
  );
  expect(r.routes.length).toBeGreaterThan(100);
});
