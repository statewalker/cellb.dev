// A worker thread that owns the Wasmer client and the container engine, served on a port.
import { parentPort } from "node:worker_threads";
import { Wasmer } from "@wasmer/sdk/node";
import { wasmerContainerEngine } from "../../src/engine.ts";
import { serveEngine } from "../../src/rpc.ts";

const { port1, port2 } = new MessageChannel();
serveEngine(port1, wasmerContainerEngine(new Wasmer({ cache: { directory: ".wasmer" } })));
parentPort!.postMessage({ port: port2 }, [port2 as never]);
