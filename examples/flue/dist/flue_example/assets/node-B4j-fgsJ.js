import { r as __exportAll } from "./rolldown-runtime-DQp2zzRu.js";
import * as fs from "node:fs";
import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import "node:os";
import * as path from "node:path";
import * as stream from "node:stream";
import * as util from "node:util";
// ../../node_modules/.pnpm/@anthropic-ai+sdk@0.129.0_zod@4.6.7/node_modules/@anthropic-ai/sdk/internal/node.mjs
/**
* The one module under `src/` that may import Node built-ins (eslint enforces this).
* The package.json `browser` field swaps it for `./node.browser`, so only touch its
* exports on code paths that run on Node-compatible runtimes.
*/
var node_exports = /* @__PURE__ */ __exportAll({
	child_process: () => child_process,
	crypto: () => crypto,
	fs: () => fs,
	path: () => path,
	stream: () => stream,
	util: () => util
});
export { path as a, node_exports as i, crypto as n, stream as o, fs as r, util as s, child_process as t };

//# sourceMappingURL=node-B4j-fgsJ.js.map