// The agent's run_script tool: JavaScript the agent writes, run in a Worker Loader isolate (a
// Dedicated Worker of its own in a browser, an isolate on workerd) with no network
// (`globalOutbound: null`) and one thing to act on: `files`, an RpcTarget over the agent's
// capability (narrowed further on request), every call authorized by the token's Datalog. For
// work a shell is clumsy at: transform JSON, generate files, compute over data, test a function.
//
//   export default async function (files, input) {
//     const rows = JSON.parse(await files.readText("/data/rows.json"));
//     await files.writeText("/data/summary.json", JSON.stringify({ n: rows.length }));
//     return rows.length;
//   }

import { RpcTarget } from "cloudflare:workers";
import { Type } from "typebox";
import type { Cap } from "./capfs/caps.ts";
import { attenuationBlock } from "./capfs/policy.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const TIMEOUT_MS = 30_000;
const MAX_RESULT = 12_000;

/** What a script holds: file methods over the capability, nothing else (no token, no handoff). */
export class ScriptFiles extends RpcTarget {
  #cap: Cap;
  constructor(cap: Cap) {
    super();
    this.#cap = cap;
  }
  async readText(path: string): Promise<string> {
    const b = (await this.#cap.call("readFileBuffer", path)) as Uint8Array;
    return dec.decode(b instanceof Uint8Array ? b : new Uint8Array(b as ArrayBuffer));
  }
  async writeText(path: string, text: string): Promise<void> {
    await this.#cap.call("writeFileBuffer", path, enc.encode(String(text)));
  }
  async list(path = "/"): Promise<{ name: string; dir: boolean; size: number }[]> {
    const entries = (await this.#cap.call("readdirStat", path)) as {
      name: string;
      isDirectory: boolean;
      size: number;
    }[];
    return entries.map((e) => ({ name: e.name, dir: e.isDirectory, size: e.size }));
  }
  async exists(path: string): Promise<boolean> {
    return (await this.#cap.call("exists", path)) as boolean;
  }
  async remove(path: string): Promise<void> {
    await this.#cap.call("rm", path, { recursive: true });
  }
}

interface WorkerLoader {
  get(
    id: string,
    load: () => Promise<{
      compatibilityDate: string;
      mainModule: string;
      modules: Record<string, string>;
      globalOutbound?: null;
    }>,
  ): { getEntrypoint(): { run(files: unknown, input: unknown): Promise<unknown> } };
}

const ENTRY = `import { WorkerEntrypoint } from "cloudflare:workers";
import run from "./script.js";
export default class extends WorkerEntrypoint {
  async run(files, input) {
    const out = await run(files, input);
    return out === undefined ? null : JSON.parse(JSON.stringify(out));
  }
}
`;

export function scriptTool(cap: Cap, loader: WorkerLoader) {
  return {
    name: "run_script",
    label: "Run a script",
    description:
      "Runs JavaScript in an isolate with no network. `code` is an ES module whose default export is `async function (files, input)`; `files` has readText(path), writeText(path, text), list(path), exists(path), remove(path) over your file rights (narrowed further by `scope` / `read_only`); the function's return value (JSON) is the result. Use it to transform or generate files, compute over data, or try a function.",
    parameters: Type.Object({
      code: Type.String({
        description: "an ES module: export default async function (files, input) { … }",
      }),
      input: Type.Optional(Type.Unknown()),
      scope: Type.Optional(Type.String({ description: "a folder the script is limited to" })),
      read_only: Type.Optional(Type.Boolean()),
    }),
    async execute(
      _id: string,
      params: { code: string; input?: unknown; scope?: string; read_only?: boolean },
    ) {
      const scope = params.scope ? `/${params.scope.replace(/^\/+|\/+$/g, "")}` : undefined;
      const held =
        scope || params.read_only
          ? await cap.attenuate(attenuationBlock({ scope, readOnly: params.read_only }))
          : cap;
      // One isolate per run: nothing one run leaves behind is seen by the next.
      const worker = loader.get(`script-${crypto.randomUUID()}`, async () => ({
        compatibilityDate: "2026-10-01",
        mainModule: "entry.js",
        modules: { "entry.js": ENTRY, "script.js": String(params.code) },
        globalOutbound: null,
      }));
      const files = new ScriptFiles(held);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          worker.getEntrypoint().run(files, params.input ?? null),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`ETIMEDOUT: the script ran over ${TIMEOUT_MS} ms`)),
              TIMEOUT_MS,
            );
          }),
        ]);
        const text = JSON.stringify(result, null, 2) ?? "null";
        return {
          content: [
            {
              type: "text",
              text: text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}… [cut]` : text,
            },
          ],
          details: undefined,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
