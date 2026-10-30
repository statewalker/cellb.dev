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
  const r = await runAstroConfig({
    esbuild,
    files,
    root: "/app",
    packages,
    vfs,
    evaluate: (code) =>
      import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`),
    log: (m) => console.log(m),
  });
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
