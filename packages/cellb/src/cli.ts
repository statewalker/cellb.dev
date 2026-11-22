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

async function serve(args: string[]): Promise<number> {
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
  console.log(`cellb serve: node ${node.node} ready ${node.url} (peer ${node.addr})`);
  return new Promise<number>((resolve) => {
    const stop = () => {
      console.log(`cellb serve: node ${node.node} leaving the fleet`);
      node.close().then(
        () => resolve(0),
        (e) => {
          console.error(`cellb serve: ${(e as Error)?.message ?? e}`);
          resolve(1);
        },
      );
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
}
