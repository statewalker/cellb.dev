// The agent's `wasmer` tool: command-line programs from the Wasmer registry (WASIX, compiled to
// WebAssembly: bash, coreutils, sqlite, python, …) run in a Wasmer sandbox in the browser, on a copy
// of the files its capability may read; the changes are written back through the capability
// (copy-in.ts). No network: packages come from the registry, nothing else is reachable.

import { Type } from "typebox";
import type { Cap } from "./capfs/caps.ts";
import { clip, copyIn, rootOf, writeBack } from "./copy-in.ts";
import type { StudioHost } from "./host-tools.ts";

export function wasmerTool(cap: Cap, host: StudioHost) {
  return {
    name: "wasmer",
    label: "Run a WASIX program",
    description:
      'Runs a command from Wasmer registry packages (WebAssembly, in the browser) with the project\'s files copied into its working directory, e.g. packages ["wasmer/bash", "wasmer/coreutils"] with command "bash" and args ["-c", "wc -l *.md > counts.txt"], or ["sqlite/sqlite"] with "sqlite" and ["data.db", "select count(*) from t"]. No network. Files it writes or deletes are applied to the project through your rights afterwards. Returns stdout, stderr, the exit code, and what was written, deleted or denied.',
    parameters: Type.Object({
      packages: Type.Array(Type.String(), {
        description: 'registry packages, e.g. "wasmer/bash" or "sqlite/sqlite@=3.45.1"',
      }),
      command: Type.String({ description: "a command one of the packages provides" }),
      args: Type.Optional(Type.Array(Type.String())),
      stdin: Type.Optional(Type.String()),
      root: Type.Optional(
        Type.String({ description: "the folder to copy in and run in (default: the project)" }),
      ),
    }),
    async execute(
      _id: string,
      params: {
        packages: string[];
        command: string;
        args?: string[];
        stdin?: string;
        root?: string;
      },
    ) {
      if (!host.wasmer) throw new Error("ENOSYS: no Wasmer engine here");
      if (!params.packages.length) throw new Error("EINVAL: name at least one package");
      // Registry names only ("namespace/name", optionally "@version"): never a URL, so the tool
      // reaches the registry and nothing else.
      for (const p of params.packages)
        if (!/^[a-z0-9][\w.-]*\/[\w.-]+(@[\w.=^~<>*|-]+)?$/i.test(p))
          throw new Error(`EINVAL: ${p} is not a registry package name such as wasmer/bash`);
      const root = rootOf(params.root);
      const files = await copyIn(cap, root);
      const out = await host.wasmer({
        files,
        packages: params.packages,
        command: params.command,
        args: params.args ?? [],
        stdin: params.stdin,
        cwd: root,
      });
      const result = {
        exitCode: out.exitCode,
        stdout: clip(out.stdout),
        stderr: clip(out.stderr),
        error: out.error ? clip(out.error) : undefined,
        ...(await writeBack(cap, out.changes)),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: undefined,
      };
    },
  };
}
