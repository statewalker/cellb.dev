// A worker that owns one Wasmer client: the engine is served on one port, and the guests'
// filesystem calls are forwarded on another, to the thread that owns the FilesApis.
import { parentPort } from "node:worker_threads";
import { Wasmer } from "@wasmer/sdk/node";
import { wasmerContainerEngine } from "../../src/engine.ts";
import { forwardHostFiles, installHostFiles } from "../../src/files/bridge.ts";
import { serveEngine } from "../../src/rpc.ts";

parentPort?.once("message", ({ engine, files }: { engine: MessagePort; files: MessagePort }) => {
  installHostFiles(forwardHostFiles(files));
  serveEngine(engine, wasmerContainerEngine(new Wasmer({ cache: { directory: ".wasmer" } })));
});
