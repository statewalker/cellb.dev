// `cellb serve --containers <this file>`: Lifo containers (shell, Node-compatible JavaScript) in a
// worker thread of the node, reached over the engine's RPC. Lifo is not a sandbox: for code you
// trust. In a worker because Lifo guards the network of the realm it runs in.
import { Worker } from "node:worker_threads";
import { HostMounts, serveHostFiles } from "../src/files/index.ts";
import { connectEngine } from "../src/rpc.ts";

export default () => {
  const worker = new Worker(new URL("./lifo-worker.ts", import.meta.url));
  worker.unref();
  const engineChannel = new MessageChannel();
  const filesChannel = new MessageChannel();
  serveHostFiles(filesChannel.port1 as never, new HostMounts());
  worker.postMessage({ engine: engineChannel.port2, files: filesChannel.port2 }, [
    engineChannel.port2,
    filesChannel.port2,
  ] as never);
  const engine = connectEngine(engineChannel.port1 as never);
  return {
    get running() {
      return engine.running;
    },
    start: engine.start.bind(engine),
    async close() {
      await engine.close();
      engineChannel.port1.close();
      filesChannel.port1.close();
      await worker.terminate();
    },
  };
};
