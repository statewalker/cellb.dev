/// <reference lib="webworker" />
// One Python container per Web Worker: a Wasmer client of its own, terminated after its run.
//
// The SDK is imported by URL from <base>wasmer-sdk/ (vite.config.ts serves it in dev and copies it
// into the build), unbundled: its own thread-pool workers import their sibling files by URL, which
// a bundler does not follow. Loading it is asynchronous, but the pool's first message may arrive at
// once: the engine is served now and waits for the SDK.
import type { Wasmer } from "@wasmer/sdk/browser";
import type { ContainerEngine } from "../../../src/engine.ts";
import { wasmerWorkerEngine } from "../../../src/engine.ts";
import { serveContainerWorker } from "../../../src/worker.ts";

const SDK = new URL(`${import.meta.env.BASE_URL}wasmer-sdk/dist/index.js`, location.origin).href;
const sdk = import(/* @vite-ignore */ SDK) as Promise<{ Wasmer: new () => Wasmer }>;

serveContainerWorker(self as never, ({ files }) => {
  const engine: Promise<ContainerEngine> = sdk.then(({ Wasmer }) =>
    wasmerWorkerEngine(new Wasmer(), files),
  );
  let running = 0;
  return {
    get running() {
      return running;
    },
    async start(spec) {
      const handle = await (await engine).start(spec);
      running++;
      void handle.monitor().then(() => running--);
      return handle;
    },
    async close() {
      await (await engine).close();
    },
  };
});
