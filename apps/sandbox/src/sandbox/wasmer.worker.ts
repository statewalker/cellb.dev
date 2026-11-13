/// <reference lib="webworker" />
// The Wasmer engine: @wasmer/sdk (Wasmer + WASIX in WebAssembly) in a Worker of its own, started by
// the studio worker for the agent's `wasmer` tool. Like the Python engine it never holds a
// capability: it gets a copy of the files (in /workspace), runs the command there, and reports
// what changed. Needs a cross-origin isolated page (SharedArrayBuffer), which the sandbox is.
//
//   in   { id, files: [path, bytes][], packages, command, args, stdin?, cwd }
//   out  { id, stdout, stderr, exitCode, error?, changes: [path, bytes | null][] }

import type { Wasmer } from "@wasmer/sdk/browser";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const ROOT = "/workspace";
const RUN_MS = 90_000;
const MAX_OUT = 256 * 1024;
let wasmer: Wasmer | undefined;
// The SDK, unbundled, next to the page (scripts/build-studio.ts copies it): its own worker imports
// its sibling files by URL.
const SDK = new URL(
  `${import.meta.env.BASE_URL.replace(/\/?$/, "/")}wasmer-sdk/dist/index.js`,
  location.origin,
).href;
let sdk: Promise<{ Wasmer: new () => Wasmer }> | undefined;

type Fs = {
  readDir(p: string): Promise<readonly { name: string; kind: "file" | "directory" }[]>;
  readFile(p: string): Promise<Uint8Array>;
};
async function walk(fs: Fs, dir: string, out: Map<string, Uint8Array>) {
  for (const e of await fs.readDir(dir)) {
    if (e.name === "." || e.name === "..") continue;
    const path = `${dir}/${e.name}`;
    if (e.kind === "directory") await walk(fs, path, out);
    else out.set(path.slice(ROOT.length), await fs.readFile(path));
  }
}
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const text = (b: Uint8Array) => {
  const t = new TextDecoder().decode(b);
  return t.length > MAX_OUT ? `${t.slice(0, MAX_OUT)}… [cut]` : t;
};

async function runOne(data: {
  id: number;
  files: [string, Uint8Array][];
  packages: string[];
  command: string;
  args: string[];
  stdin?: string;
  cwd?: string;
}) {
  const { id } = data;
  sdk ??= import(/* @vite-ignore */ SDK);
  wasmer ??= new (await sdk).Wasmer();
  // The SDK puts relative paths under /workspace.
  const files: Record<string, Uint8Array> = {};
  for (const [path, bytes] of data.files) files[path.replace(/^\/+/, "")] = bytes;
  const sandbox = await wasmer.sandboxes.create({ packages: data.packages, files });
  try {
    const cwd = `${ROOT}${data.cwd && data.cwd !== "/" ? data.cwd : ""}`;
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let error: string | undefined;
    try {
      const out = await sandbox.command(data.command, data.args, { cwd }).run({
        stdin: data.stdin,
        timeoutMs: RUN_MS,
        outputBytes: MAX_OUT,
        check: false,
      });
      stdout = text(out.stdout.bytes);
      stderr = text(out.stderr.bytes);
      exitCode = out.exitCode;
      if (out.reason !== "exited") error = `the command was ${out.reason}`;
    } catch (err) {
      error = String((err as Error)?.message ?? err);
    }
    const before = new Map(data.files);
    const after = new Map<string, Uint8Array>();
    await walk(sandbox.fs as unknown as Fs, ROOT, after);
    const changes: [string, Uint8Array | null][] = [];
    for (const [path, bytes] of after) {
      const was = before.get(path);
      if (!was || !same(was, bytes)) changes.push([path, bytes]);
    }
    for (const path of before.keys()) if (!after.has(path)) changes.push([path, null]);
    scope.postMessage({ id, stdout, stderr, exitCode, error, changes });
  } finally {
    await sandbox.close().catch(() => {});
  }
}

// One run at a time: each run has a sandbox of its own, but downloads and memory are shared.
let running: Promise<void> = Promise.resolve();
scope.addEventListener("message", (e: MessageEvent) => {
  const data = e.data;
  running = running
    .then(() => runOne(data))
    .catch((err) =>
      scope.postMessage({
        id: data?.id,
        stdout: "",
        stderr: "",
        exitCode: null,
        error: `the Wasmer engine: ${String((err as Error)?.message ?? err)}`,
        changes: [],
      }),
    );
});
