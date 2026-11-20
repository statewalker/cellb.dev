/// <reference lib="webworker" />
// The engine's worker: the Wasmer client, the container engine (served to the page), and the
// filesystem handler, which forwards every guest call to the page, where the FilesApi lives.
import { Wasmer } from "@wasmer/sdk/browser";
import { wasmerContainerEngine } from "../../src/engine.ts";
import { forwardHostFiles, installHostFiles } from "../../src/files/bridge.ts";
import { serveEngine } from "../../src/rpc.ts";

self.addEventListener("message", (e: MessageEvent) => {
  const { engine, files } = e.data as { engine: MessagePort; files: MessagePort };
  installHostFiles(forwardHostFiles(files));
  serveEngine(engine, wasmerContainerEngine(new Wasmer()));
});
