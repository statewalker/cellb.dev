// `cellb serve --containers <this file>`: Wasmer (WASIX) sandboxes in the node's process. Packages
// come from the Wasmer registry, cached in WASMER_CACHE (default packages/containers/.wasmer).
import { fileURLToPath } from "node:url";
import { Wasmer } from "@wasmer/sdk/node";
import { wasmerContainerEngine } from "../src/engine.ts";

export default () => {
  const wasmer = new Wasmer({
    cache: {
      directory: process.env.WASMER_CACHE ?? fileURLToPath(new URL("../.wasmer", import.meta.url)),
    },
  });
  const engine = wasmerContainerEngine(wasmer);
  return {
    get running() {
      return engine.running;
    },
    start: engine.start.bind(engine),
    async close() {
      await engine.close();
      await wasmer.close();
    },
  };
};
