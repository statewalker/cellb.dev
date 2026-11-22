/**
 * One thread of `startProjectShards` on Node (node-shards.ts): the project's runtime, its cells
 * in a SQLite directory of its own, the other threads' cells reached over ports, and, with the
 * main thread's FilesApi, the cells' LTX log written there over a port.
 */
import { mkdirSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { type MessagePort, parentPort, workerData } from "node:worker_threads";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { filesApiLtxLog } from "../adapters/files-ltx.js";
import { nodeSqliteOpener } from "../adapters/node-sqlite.js";
import { shardOf } from "../core/shard.js";
import { rpcFilesClient } from "../ltx/files-rpc.js";
import { linkOverPort, serveRuntime } from "../transport/port.js";
import { loadNodeProject } from "./node-project.js";

// From the TypeScript sources (cellb's own tests), the project loader's own modules, which the
// project's bundle imports at run time, are `.ts` files imported as `.js`: Node strips their types
// but resolves no `.js` to `.ts`, so this hook does. The built package (`dist/`) needs none.
if (import.meta.filename.endsWith(".ts"))
  register(
    `data:text/javascript,${encodeURIComponent(`
      export async function resolve(spec, ctx, next) {
        try { return await next(spec, ctx); } catch (err) {
          if (!spec.endsWith(".js") || !ctx.parentURL?.endsWith(".ts")) throw err;
          return next(spec.slice(0, -3) + ".ts", ctx);
        }
      }`)}`,
  );

const { shard, shards, dir, data } = workerData as {
  shard: number;
  shards: number;
  dir: string;
  data?: string;
};

interface Wiring {
  reply: MessagePort;
  ingress: MessagePort;
  peers: { shard: number; role: "link" | "serve"; port: MessagePort }[];
  files?: MessagePort;
}

const parent = parentPort as NonNullable<typeof parentPort>;
parent.once("message", async (m: Wiring) => {
  try {
    const links = new Map<number, (req: Request) => Promise<Response>>();
    const served: MessagePort[] = [];
    for (const peer of m.peers)
      if (peer.role === "link")
        links.set(peer.shard, (await linkOverPort(peer.port as never)).send);
      else served.push(peer.port);
    const storage = m.files ? filesApiLtxLog(rpcFilesClient(m.files as never)) : undefined;
    let files: FilesApi = new MemFilesApi();
    if (data) {
      mkdirSync(join(data, "files"), { recursive: true });
      files = new NodeFilesApi({ rootDir: join(data, "files") });
    }
    const { runtime } = await loadNodeProject(dir, {
      // With the main thread's FilesApi, its log is the cells' truth: they are restored into
      // temporary files at each run. A cell file kept in `data` from an earlier run (another
      // thread count) could be older than the log, and without a lease the object host would
      // take a local file over the log, rolling the cell back.
      openSql: nodeSqliteOpener(storage ? undefined : data, { pageCapture: !!storage }),
      files,
      storage,
      route: (_key, id) => {
        const owner = shardOf(id.toString(), shards);
        return owner === shard ? undefined : links.get(owner);
      },
    });
    for (const port of [...served, m.ingress]) serveRuntime(port as never, runtime);
    parent.once("message", async (c: { type: string; reply: MessagePort }) => {
      if (c?.type !== "close") return;
      try {
        await runtime.close();
        c.reply.postMessage({ ok: true });
      } catch (err) {
        c.reply.postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
      }
    });
    m.reply.postMessage({ ok: true });
  } catch (err) {
    m.reply.postMessage({ ok: false, error: String((err as Error)?.stack ?? err).slice(0, 2000) });
  }
});
