/**
 * One project over several worker threads on Node, as `startProjectShards` runs one over several
 * browser workers: each thread hosts the project with a SQLite directory of its own and owns the
 * cells that `shardOf(id, shards)` gives it. A port links every two threads, so a Durable Object
 * call from any thread runs in the owner's. Ingress goes round robin over the threads.
 *
 *   main thread:  startProjectShards({ shards, dir, data?, files? })  → { fetch, shards, close }
 *   each thread:  node-shard-entry.ts (built once with esbuild, as the isolate entry is)
 *
 * With `files`, the cells' LTX log goes to that FilesApi, served from the main thread over a port
 * per thread. The cells then belong to the FilesApi: a later run with another number of threads,
 * or empty data directories, opens them where the last one left off.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { MessageChannel, type MessagePort, Worker } from "node:worker_threads";
import type { FilesApi } from "@statewalker/webrun-files";
import { build } from "esbuild";
import { serveFilesApi } from "../ltx/files-rpc.js";
import type { RemoteRuntime } from "../transport/cells-http.js";
import { connectRuntime } from "../transport/port.js";
import { ownModule } from "./own-module.js";

export interface NodeProjectShardsOptions {
  /** Number of worker threads. */
  shards: number;
  /** The project's folder (`wrangler.json(c)` and its `main`), as `loadNodeProject` takes. */
  dir: string;
  /** A directory for the cells: thread `i` keeps its SQLite files in `<data>/s<i>`. Memory without it. */
  data?: string;
  /** Where the cells' LTX log goes (a folder, S3, memory), served from this thread over a port. */
  files?: FilesApi;
}

export interface NodeProjectShards {
  /** Ingress: a request to the project's Worker, in the next thread (round robin). */
  fetch(req: Request): Promise<Response>;
  /** The threads' runtimes, by shard number. */
  readonly shards: RemoteRuntime[];
  /** Closes every thread's runtime, then ends the threads. */
  close(): Promise<void>;
}

let entry: Promise<string> | undefined;
/** The thread's script, bundled once per process (from the TS sources or the built package). */
function shardEntry(): Promise<string> {
  entry ??= (async () => {
    const outfile = join(mkdtempSync(join(tmpdir(), "cellb-shard-")), "shard.mjs");
    await build({
      entryPoints: [ownModule(import.meta.dirname, "./node-shard-entry")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
      // The thread bundles the project's Worker with esbuild, a native package: it is imported from
      // where this module resolves it, since the script lives in a temporary directory.
      plugins: [
        {
          name: "cellb-esbuild-external",
          setup(b) {
            const path = createRequire(import.meta.url).resolve("esbuild");
            b.onResolve({ filter: /^esbuild$/ }, () => ({ path, external: true }));
          },
        },
        {
          // The project loader finds its own files (the cloudflare:workers module, the globals) from
          // `import.meta.dirname`: each of cellb's modules keeps its real location in the bundle.
          name: "cellb-own-location",
          setup(b) {
            b.onLoad({ filter: /[\\/]cellb[\\/](src|dist)[\\/].*\.[jt]s$/ }, (args) => {
              const code = readFileSync(args.path, "utf8")
                .replaceAll("import.meta.dirname", JSON.stringify(dirname(args.path)))
                .replaceAll("import.meta.filename", JSON.stringify(args.path))
                .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(args.path).href));
              return { contents: code, loader: args.path.endsWith(".ts") ? "ts" : "js" };
            });
          },
        },
      ],
      banner: {
        js: "import { createRequire as __cellbRequire } from 'node:module'; const require = __cellbRequire(import.meta.url);",
      },
    });
    return outfile;
  })();
  entry.catch(() => {
    entry = undefined; // a failed build is tried again by the next call
  });
  return entry;
}

export async function startProjectShards(
  opts: NodeProjectShardsOptions,
): Promise<NodeProjectShards> {
  if (!Number.isInteger(opts.shards) || opts.shards < 1)
    throw new Error(`startProjectShards: shards must be a positive integer, got ${opts.shards}`);
  const script = await shardEntry();
  const workers = Array.from(
    { length: opts.shards },
    (_, i) =>
      new Worker(script, {
        workerData: {
          shard: i,
          shards: opts.shards,
          dir: opts.dir,
          data: opts.data && join(opts.data, `s${i}`),
        },
      }),
  );
  const ask = (w: Worker, msg: Record<string, unknown>, transfer: MessagePort[]) =>
    new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const { port1, port2 } = new MessageChannel();
      const onExit = (code: number) => resolve({ ok: false, error: `thread exited (${code})` });
      w.once("exit", onExit);
      port1.once("message", (r) => {
        w.off("exit", onExit);
        port1.close();
        resolve(r);
      });
      w.postMessage({ ...msg, reply: port2 }, [port2, ...transfer]);
    });
  const stops: (() => void)[] = [];
  const end = async () => {
    for (const stop of stops) stop();
    await Promise.all(workers.map((w) => w.terminate()));
  };
  try {
    // A channel between every two threads: one end links (sends to), the other is served.
    const peers = workers.map(() => [] as { shard: number; role: string; port: MessagePort }[]);
    for (let i = 0; i < opts.shards; i++)
      for (let j = 0; j < opts.shards; j++) {
        if (i === j) continue;
        const { port1, port2 } = new MessageChannel();
        peers[i].push({ shard: j, role: "link", port: port1 });
        peers[j].push({ shard: i, role: "serve", port: port2 });
      }
    const ingress = workers.map(() => new MessageChannel());
    const started = await Promise.all(
      workers.map((w, i) => {
        let files: MessagePort | undefined;
        if (opts.files) {
          const ch = new MessageChannel();
          stops.push(serveFilesApi(ch.port1 as never, opts.files));
          files = ch.port2;
        }
        return ask(w, { peers: peers[i], ingress: ingress[i].port2, files }, [
          ingress[i].port2,
          ...peers[i].map((p) => p.port),
          ...(files ? [files] : []),
        ]);
      }),
    );
    const failed = started.find((r) => !r.ok);
    if (failed) throw new Error(`a project shard did not start: ${failed.error}`);
    const remotes = await Promise.all(ingress.map((c) => connectRuntime(c.port1 as never)));
    let next = 0;
    return {
      fetch: (req) => remotes[next++ % remotes.length].fetch(req),
      shards: remotes,
      async close() {
        await Promise.all(remotes.map((r) => r.close()));
        await Promise.all(workers.map((w) => ask(w, { type: "close" }, [])));
        await end();
      },
    };
  } catch (err) {
    await end();
    throw err;
  }
}
