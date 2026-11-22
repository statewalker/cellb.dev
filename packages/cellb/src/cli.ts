#!/usr/bin/env node
/**
 * The `cellb` command.
 *
 *   cellb build <project-dir> [--out <dir>]   writes a folder `loadProject` loads in a browser
 *   cellb serve [project-dir] --bucket s3://NAME[/PREFIX] …   runs a node of a celld fleet
 */
import { buildProject } from "./project/build.js";

const USAGE = `Usage:
  cellb build <project-dir> [--out <dir>] [--no-lower-await]

    Bundles the project's \`main\` for browsers and writes wrangler.json, worker.js, assets/ and
    cellb.json into <dir> (default: <project-dir>/dist/cellb), for loadProject() from
    @statewalker/cellb/browser or @statewalker/cellb/node.

  cellb serve [project-dir] --bucket s3://NAME[/PREFIX] [--endpoint URL] [--region REGION]
              [--listen IP:PORT] [--internal-listen IP:PORT] [--advertise ADDR:PORT]
              [--node NAME] [--lease-ttl MS] [--data DIR]

    Runs the project as a node of a celld fleet: the same bucket, ownership records and peer
    tunnel as \`celld --bucket\`, so celld and cellb nodes serve one set of cells together.
    Credentials: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (AWS_SESSION_TOKEN). Defaults:
    CELLD_BUCKET, S3_ENDPOINT, AWS_REGION; --listen 127.0.0.1:8080, --internal-listen
    127.0.0.1:0. SIGTERM or SIGINT releases the node's cells and leaves the fleet.`;

/** Runs the command line `args` (without node and the script); returns the exit code. */
export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  if (command === "serve") return serve(rest);
  if (command !== "build") {
    console.error(`cellb: unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
    return 1;
  }
  let dir: string | undefined;
  let out: string | undefined;
  let lowerAwait: boolean | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out" || a === "-o") out = rest[++i];
    else if (a.startsWith("--out=")) out = a.slice(6);
    else if (a === "--no-lower-await") lowerAwait = false;
    else if (a.startsWith("-")) {
      console.error(`cellb build: unknown option ${a}\n\n${USAGE}`);
      return 1;
    } else if (dir === undefined) dir = a;
    else {
      console.error(`cellb build: one project directory only\n\n${USAGE}`);
      return 1;
    }
  }
  if (!dir || (out !== undefined && !out)) {
    console.error(USAGE);
    return 1;
  }
  out ??= `${dir.replace(/\/+$/, "")}/dist/cellb`;
  try {
    const manifest = await buildProject(dir, out, { lowerAwait });
    console.log(
      `cellb build: ${out} (${manifest.main ?? "no main"}, ${manifest.assets.length} asset file(s))`,
    );
    return 0;
  } catch (err) {
    console.error(`cellb build: ${(err as Error).message ?? err}`);
    return 1;
  }
}

const FRAME = "--experimental-async-context-frame";
const NO_FRAME = "--no-experimental-async-context-frame";
const nodeMajor = (version: string) => Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
const mentions = (flag: string, execArgv: string[], nodeOptions?: string) =>
  execArgv.includes(flag) || (nodeOptions ?? "").split(/\s+/).includes(flag);

/**
 * The Node flags `cellb serve` adds: AsyncLocalStorage on AsyncContextFrame, the default from
 * Node 24. On Node 22's async_hooks every promise pays for it, and a fleet node served 2.7 times
 * fewer requests (bench/cluster-bench.mjs). A flag either way in execArgv or NODE_OPTIONS wins.
 */
export function asyncContextFrameArgs(
  version: string,
  execArgv: string[],
  nodeOptions: string | undefined,
): string[] {
  if (nodeMajor(version) >= 24) return [];
  if (mentions(FRAME, execArgv, nodeOptions) || mentions(NO_FRAME, execArgv, nodeOptions))
    return [];
  return [FRAME];
}

const asyncLocalStorageMode = () =>
  mentions(NO_FRAME, process.execArgv, process.env.NODE_OPTIONS)
    ? "async_hooks"
    : nodeMajor(process.version) >= 24 ||
        mentions(FRAME, process.execArgv, process.env.NODE_OPTIONS)
      ? "frame"
      : "async_hooks";

/** Runs this command again in a Node with `flags`, forwarding signals; its exit code. */
async function relaunch(flags: string[]): Promise<number> {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [...process.execArgv, ...flags, ...process.argv.slice(1)], {
    // the IPC channel tells the child when this process dies, SIGKILL included
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: { ...process.env, CELLB_RELAUNCHED: "1" },
  });
  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  const onTerm = forward("SIGTERM");
  const onInt = forward("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  return new Promise<number>((resolve) =>
    child.once("exit", (code, signal) => {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      resolve(code ?? (signal ? 1 : 0));
    }),
  );
}

async function serve(args: string[]): Promise<number> {
  const flags = asyncContextFrameArgs(process.version, process.execArgv, process.env.NODE_OPTIONS);
  if (flags.length && !process.env.CELLB_RELAUNCHED) return relaunch(flags);
  // Relaunched: the parent, which is the node to its supervisor, died (a SIGKILL cannot be
  // forwarded), so this process dies with it, as abruptly.
  if (process.env.CELLB_RELAUNCHED && process.send) {
    process.once("disconnect", () => process.exit(137));
    // the channel only watches the parent: it must not keep this process alive after close()
    (process.channel as { unref?: () => void } | undefined)?.unref?.();
  }
  const { parseServeArgs, startFleetNode } = await import("./peer/fleet-node.js");
  let o: ReturnType<typeof parseServeArgs>;
  try {
    o = parseServeArgs(args, process.env);
  } catch (err) {
    console.error(`cellb serve: ${(err as Error).message}\n\n${USAGE}`);
    return 1;
  }
  const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
  if (!accessKeyId || !secretAccessKey) {
    console.error("cellb serve: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for the bucket");
    return 1;
  }
  const credentials = { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN };
  if (!credentials.sessionToken) delete credentials.sessionToken;
  let node: Awaited<ReturnType<typeof startFleetNode>>;
  try {
    node = await startFleetNode({ ...o, credentials });
  } catch (err) {
    console.error(`cellb serve: ${(err as Error).message ?? err}`);
    return 1;
  }
  if (node.unsupported.length)
    console.error(`cellb serve: unsupported: ${node.unsupported.join("; ")}`);
  console.log(
    `cellb serve: node ${node.node} ready ${node.url} (peer ${node.addr}; AsyncLocalStorage: ${asyncLocalStorageMode()})`,
  );
  return onStopSignals(async () => {
    console.log(`cellb serve: node ${node.node} leaving the fleet`);
    await node.close();
  });
}

/**
 * Runs `stop` on the first SIGTERM or SIGINT and settles with the exit code (0, or 1 if `stop`
 * failed). The handlers stay registered until then, and later signals are ignored: a signal sent
 * to the process group reaches a relaunched `cellb serve` twice (from the group, and forwarded by
 * its parent), and with no handler left the second copy would kill the node before it released
 * its cells.
 */
export function onStopSignals(stop: () => Promise<void>): Promise<number> {
  return new Promise<number>((resolve) => {
    let stopping = false;
    const onSignal = () => {
      if (stopping) return;
      stopping = true;
      stop().then(
        () => finish(0),
        (e) => {
          console.error(`cellb: ${(e as Error)?.message ?? e}`);
          finish(1);
        },
      );
    };
    const finish = (code: number) => {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      resolve(code);
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  });
}
