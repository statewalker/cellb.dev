// The agent's `python` tool: Python (Pyodide) on a copy of the files its capability may read,
// the changes written back through the capability (copy-in.ts).

import { Type } from "typebox";
import type { Cap } from "./capfs/caps.ts";
import { clip, copyIn, rootOf, writeBack } from "./copy-in.ts";
import type { StudioHost } from "./host-tools.ts";

export function pythonTool(cap: Cap, host: StudioHost) {
  return {
    name: "python",
    label: "Run Python",
    description:
      "Runs Python 3 (Pyodide, in the browser) with the project's files copied into its working directory (open('data.csv'), csv, json, sqlite3; packages such as numpy or pandas are loaded from their imports). Files it writes or deletes are applied to the project through your rights afterwards. Returns stdout, stderr, the last expression's value, and what was written, deleted or denied.",
    parameters: Type.Object({
      code: Type.String(),
      root: Type.Optional(
        Type.String({ description: "the folder to copy in (default: the project)" }),
      ),
    }),
    async execute(_id: string, params: { code: string; root?: string }) {
      if (!host.python) throw new Error("ENOSYS: no Python engine here");
      const root = rootOf(params.root);
      const files = await copyIn(cap, root);
      const out = await host.python({ files, code: params.code, cwd: root });
      const result = {
        stdout: clip(out.stdout),
        stderr: clip(out.stderr),
        value: out.value,
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
