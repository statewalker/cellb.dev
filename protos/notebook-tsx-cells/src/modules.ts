// PROTOTYPE (statewalker/statewalker-root#236). The module server behind `/_m/`: webrun-modules
// (npm packages pinned and served as ESM, one file per module), wrapped with cellb.dev's
// `withLocalBuiltins`, so notebook-kit's `https://esm.sh/…` imports name local packages instead,
// resolved lazily when a cell first uses one.
import { join } from "node:path";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { newModuleServer } from "@statewalker/webrun-modules";
import { type LocalBuiltinsServer, withLocalBuiltins } from "../../../packages/notebooks/src/builtins.ts";

export const MODULES_BASE = "/_m/";

export function createModuleServer(cacheDir = join(import.meta.dirname, "..", ".cache", "modules")): LocalBuiltinsServer {
  const server = newModuleServer({ cache: new NodeFilesApi({ rootDir: cacheDir }), basePath: MODULES_BASE });
  return withLocalBuiltins(server, MODULES_BASE);
}
