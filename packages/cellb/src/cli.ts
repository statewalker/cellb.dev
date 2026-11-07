#!/usr/bin/env node
/**
 * The `cellb` command.
 *
 *   cellb build <project-dir> [--out <dir>]   writes a folder `loadProject` loads in a browser
 */
import { buildProject } from "./project/build.js";

const USAGE = `Usage:
  cellb build <project-dir> [--out <dir>] [--no-lower-await]

    Bundles the project's \`main\` for browsers and writes wrangler.json, worker.js, assets/ and
    cellb.json into <dir> (default: <project-dir>/dist/cellb), for loadProject() from
    @statewalker/cellb/browser or @statewalker/cellb/node.`;

/** Runs the command line `args` (without node and the script); returns the exit code. */
export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return command ? 0 : 1;
  }
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
