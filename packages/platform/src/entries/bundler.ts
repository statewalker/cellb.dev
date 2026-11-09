// The bundler app alone (with the package store): only esbuild.wasm. `POST /builds?project=…`
// needs the projects app in the same script; this entry takes uploads (ZIP or JSON).

import { provideWasm } from "@statewalker/cellb-platform-core/wasm";
import esbuildWasm from "esbuild-wasm/esbuild.wasm";
import { createHandler, type PlatformEnv } from "../platform.js";

provideWasm({ esbuild: esbuildWasm });
const handle = createHandler(["registry", "bundler"]);

export { BuildJob, PackageRegistry } from "../platform.js";
export default {
  fetch: (request: Request, env: PlatformEnv, ctx: ExecutionContext) => handle(request, env, ctx),
};
