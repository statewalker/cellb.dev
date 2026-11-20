// One thread of the Node spread probe (node.ts): the project's runtime, its cells in a SQLite
// directory of its own, the other threads' cells reached over ports (the same wiring as
// startProjectShards in a browser), and optionally its cells' LTX log on the host's FilesApi,
// which the main thread serves over a port.
import { parentPort, workerData } from "node:worker_threads";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { filesApiLtxLog } from "../../src/adapters/files-ltx.ts";
import { nodeSqliteOpener } from "../../src/adapters/node-sqlite.ts";
import { shardOf } from "../../src/core/shard.ts";
import { rpcFilesClient } from "../../src/ltx/files-rpc.ts";
import { createProjectRuntime } from "../../src/project/wrangler.ts";
import { linkOverPort, serveRuntime } from "../../src/transport/port.ts";
import * as worker from "./project/index.js";

const { shard, shards, dir, config } = workerData as {
  shard: number;
  shards: number;
  dir: string;
  config: any;
};
(globalThis as any).__spreadWorker = `t${shard}`;

parentPort!.once("message", async (m: any) => {
  const reply: MessagePort = m.reply;
  try {
    const links = new Map<number, (req: Request) => Promise<Response>>();
    const served: MessagePort[] = [];
    for (const peer of m.peers as { shard: number; role: "link" | "serve"; port: MessagePort }[])
      if (peer.role === "link") links.set(peer.shard, (await linkOverPort(peer.port as any)).send);
      else served.push(peer.port);
    const storage = m.files ? filesApiLtxLog(rpcFilesClient(m.files)) : undefined;
    const { runtime } = createProjectRuntime(config, worker as any, {
      openSql: nodeSqliteOpener(dir, { pageCapture: !!storage }),
      files: new NodeFilesApi({ rootDir: dir }),
      storage,
      route: (_key, id) => {
        const owner = shardOf(id.toString(), shards);
        return owner === shard ? undefined : links.get(owner);
      },
    });
    for (const port of [...served, m.ingress]) await serveRuntime(port as any, runtime);
    parentPort!.once("message", async (c: any) => {
      if (c?.type !== "close") return;
      await runtime.close();
      c.reply.postMessage({ ok: true });
    });
    reply.postMessage({ ok: true });
  } catch (err) {
    reply.postMessage({ ok: false, error: String((err as Error)?.stack ?? err).slice(0, 800) });
  }
});
