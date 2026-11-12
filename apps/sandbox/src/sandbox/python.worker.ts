/// <reference lib="webworker" />
// The Python engine: Pyodide (CPython compiled to WebAssembly) in a Worker of its own, started by
// the studio worker for the agent's `python` tool. It never holds a capability: it gets a copy of
// the files the agent's capability may read (in /workspace), runs the code there, and reports
// what changed; the studio writes those changes back through the capability, each authorized.
//
//   in   { id, files: [path, bytes][], code, cwd }
//   out  { id, stdout, stderr, value, error, changes: [path, bytes | null][] }

export const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";

interface Pyodide {
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    readdir(path: string): string[];
    stat(path: string): { mode: number };
    isDir(mode: number): boolean;
    rmdir(path: string): void;
    unlink(path: string): void;
    chdir(path: string): void;
  };
  setStdout(o: { batched: (s: string) => void }): void;
  setStderr(o: { batched: (s: string) => void }): void;
  runPythonAsync(code: string): Promise<unknown>;
  loadPackagesFromImports(code: string): Promise<void>;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
const ROOT = "/workspace";
const MAX_OUT = 256 * 1024;
let pyodide: Promise<Pyodide> | undefined;

function load(): Promise<Pyodide> {
  pyodide ??= (async () => {
    const mod = (await import(/* @vite-ignore */ `${PYODIDE_URL}pyodide.mjs`)) as {
      loadPyodide(o: { indexURL: string }): Promise<Pyodide>;
    };
    return mod.loadPyodide({ indexURL: PYODIDE_URL });
  })();
  return pyodide;
}

function walk(py: Pyodide, dir: string, out: Map<string, Uint8Array>) {
  for (const name of py.FS.readdir(dir)) {
    if (name === "." || name === "..") continue;
    const path = `${dir}/${name}`;
    if (py.FS.isDir(py.FS.stat(path).mode)) walk(py, path, out);
    else out.set(path.slice(ROOT.length), py.FS.readFile(path));
  }
}

function clear(py: Pyodide, dir: string) {
  for (const name of py.FS.readdir(dir)) {
    if (name === "." || name === "..") continue;
    const path = `${dir}/${name}`;
    if (py.FS.isDir(py.FS.stat(path).mode)) {
      clear(py, path);
      py.FS.rmdir(path);
    } else py.FS.unlink(path);
  }
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

scope.addEventListener("message", async (e: MessageEvent) => {
  const { id, files, code, cwd } = e.data as {
    id: number;
    files: [string, Uint8Array][];
    code: string;
    cwd?: string;
  };
  let stdout = "";
  let stderr = "";
  try {
    const py = await load();
    py.FS.mkdirTree(ROOT);
    clear(py, ROOT); // every run starts from the capability's files, nothing left from before
    const before = new Map(files);
    for (const [path, bytes] of files) {
      const full = `${ROOT}${path}`;
      py.FS.mkdirTree(full.slice(0, full.lastIndexOf("/")));
      py.FS.writeFile(full, bytes);
    }
    py.FS.chdir(`${ROOT}${cwd && cwd !== "/" ? cwd : ""}`);
    py.setStdout({ batched: (s) => void (stdout.length < MAX_OUT && (stdout += `${s}\n`)) });
    py.setStderr({ batched: (s) => void (stderr.length < MAX_OUT && (stderr += `${s}\n`)) });
    let value: unknown;
    let error: string | undefined;
    try {
      await py.loadPackagesFromImports(code);
      const v = await py.runPythonAsync(code);
      value = v === undefined || v === null ? null : String(v);
    } catch (err) {
      error = String((err as Error)?.message ?? err);
    }
    const after = new Map<string, Uint8Array>();
    walk(py, ROOT, after);
    const changes: [string, Uint8Array | null][] = [];
    for (const [path, bytes] of after) {
      const was = before.get(path);
      if (!was || !same(was, bytes)) changes.push([path, bytes]);
    }
    for (const path of before.keys()) if (!after.has(path)) changes.push([path, null]);
    scope.postMessage({ id, stdout, stderr, value, error, changes });
  } catch (err) {
    scope.postMessage({
      id,
      stdout,
      stderr,
      value: null,
      error: `the Python engine: ${String((err as Error)?.message ?? err)}`,
      changes: [],
    });
  }
});
