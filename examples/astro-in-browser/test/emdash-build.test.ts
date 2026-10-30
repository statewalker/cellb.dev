import { join } from "node:path";
import { transform } from "@astrojs/compiler-rs";
import { CELLS_GLOBALS_MODULE, cellbHostModule } from "@statewalker/cellb/host-modules";
import { npmPackages } from "@statewalker/webrun-bundler";
import * as esbuild from "esbuild-wasm";
import { expect, it } from "vitest";
import { buildAstroApp } from "../src/builder/build.ts";
import { preloadVfs, runAstroConfig } from "../src/builder/integrations.ts";
import { appFiles } from "./load-app.ts";

it("builds EmDash's blog template (integrations, routes, virtual modules) for cellb", async () => {
  const files = await appFiles(join(import.meta.dirname, "../../emdash"));
  const packages = npmPackages();
  const { vfs, mounts } = await preloadVfs(files, "/app", packages, [
    ["emdash"],
    ["@emdash-cms/admin", "emdash"],
    ["astro"],
  ]);
  const integration = await runAstroConfig({
    esbuild,
    files,
    root: "/app",
    packages,
    vfs,
    evaluate: (code) =>
      import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`),
  });
  const built = await buildAstroApp({
    esbuild,
    transform: transform as never,
    files,
    root: "/app",
    packages,
    integration,
    nodeMounts: mounts,
    hostModules: cellbHostModule,
    inject: [CELLS_GLOBALS_MODULE],
    session: { driver: "unstorage/drivers/cloudflare-kv-binding", options: { binding: "SESSION" } },
    log: (m) => console.log(m),
  });
  console.log(
    `built in ${built.ms} ms: ${(built.code.length / 1e6).toFixed(2)} MB, ${built.inputs.length} inputs`,
  );
  expect(built.routes.length).toBeGreaterThan(200);
  (await import("node:fs")).writeFileSync("/tmp/emdash-worker.js", built.code);
});
