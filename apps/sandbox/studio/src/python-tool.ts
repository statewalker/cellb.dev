// The agent's `python` tool: Python (Pyodide) on the files its capability may read. The engine
// (the host's: a Worker in the sandbox) never holds the capability. Before the run, the files under
// `root` that the capability may read are copied in (readTree: each one authorized); after it,
// each change is written back through the capability, authorized again: a write the capability
// refuses is reported as denied, not applied.

import { Type } from "typebox";
import type { Cap } from "./capfs/caps.ts";
import type { StudioHost } from "./host-tools.ts";

const SKIP = ["node_modules", ".git", ".cellb", ".wrangler", "dist", ".astro", ".turbo", ".cache"];
const MAX_FILES = 5000;
const MAX_BYTES = 16 * 1024 * 1024;
const clip = (s: string, n = 6000) => (s.length > n ? `${s.slice(0, n)}… [cut]` : s);

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
      const root = params.root ? `/${params.root.replace(/^\/+|\/+$/g, "")}` : "/";
      const tree = (await cap.call("readTree", root, {
        contents: true,
        skip: SKIP,
        maxFiles: MAX_FILES,
      })) as {
        path: string;
        dir?: boolean;
        data?: Uint8Array;
      }[];
      let bytes = 0;
      const files: [string, Uint8Array][] = [];
      for (const e of tree) {
        if (e.dir || !e.data) continue;
        bytes += e.data.length;
        if (bytes > MAX_BYTES) throw new Error(`EFBIG: more than ${MAX_BYTES} bytes under ${root}`);
        files.push([e.path, e.data]);
      }
      const out = await host.python({ files, code: params.code, cwd: root });
      const written: string[] = [];
      const deleted: string[] = [];
      const denied: { path: string; error: string }[] = [];
      for (const [path, data] of out.changes) {
        try {
          if (data) {
            await cap.call("writeFileBuffer", path, data);
            written.push(path);
          } else {
            await cap.call("rm", path, { force: true });
            deleted.push(path);
          }
        } catch (err) {
          denied.push({ path, error: String((err as Error)?.message ?? err) });
        }
      }
      const result = {
        stdout: clip(out.stdout),
        stderr: clip(out.stderr),
        value: out.value,
        error: out.error ? clip(out.error) : undefined,
        written,
        deleted,
        denied,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: undefined,
      };
    },
  };
}
