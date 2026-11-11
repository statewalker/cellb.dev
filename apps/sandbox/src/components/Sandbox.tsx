import { hostSitesForWorker } from "@statewalker/cellb/site";
import { zip } from "@statewalker/cellb-platform-core/util";
import {
  Download,
  ExternalLink,
  Eye,
  FileCode2,
  FolderOpen,
  Play,
  RefreshCw,
  Save,
  ScrollText,
  Sparkles,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeEditor } from "@/components/CodeEditor";
import { FileTree } from "@/components/FileTree";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  canPickFolder,
  ensureWritable,
  filesFromInput,
  folderSignature,
  type LocalFolder,
  mkdirInFolder,
  moveInFolder,
  pickFolder,
  readFolder,
  removeFromFolder,
  writeToFolder,
} from "@/sandbox/folder";
import {
  decode,
  describeProject,
  encode,
  normalizePath,
  type ProjectFiles,
} from "@/sandbox/project";
import type { FromRunner, ToRunner } from "@/sandbox/protocol";
import { SAMPLE_NAME, sampleFiles } from "@/sandbox/sample";
import {
  addDir,
  addFile,
  EditError,
  move,
  remove,
  type Workspace,
  writeFile,
} from "@/sandbox/workspace";

type Status =
  | { kind: "empty" }
  | { kind: "building" }
  | { kind: "running"; baseUrl: string; server: boolean; client: boolean }
  | { kind: "failed"; error: string }
  | { kind: "stopped" };

interface LogLine {
  id: number;
  at: number;
  text: string;
  level: "info" | "error";
}

interface Loaded {
  name: string;
  files: ProjectFiles;
  /** Folders with no file in them yet (made in the tree). */
  dirs?: Set<string>;
  folder?: LocalFolder;
  signature?: string;
}

const workspaceOf = (l: Loaded): Workspace => ({ files: l.files, dirs: l.dirs ?? new Set() });

const WATCH_MS = 1500;
let logId = 0;

export default function Sandbox() {
  const worker = useRef<Worker | null>(null);
  const [loaded, setLoaded] = useState<Loaded>();
  const [status, setStatus] = useState<Status>({ kind: "empty" });
  const [log, setLog] = useState<LogLine[]>([]);
  const [tab, setTab] = useState("preview");
  const [selected, setSelected] = useState<string>();
  const [watch, setWatch] = useState(true);
  const [previewPath, setPreviewPath] = useState("");
  const [frameKey, setFrameKey] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const picker = useMemo(canPickFolder, []);
  // Unsaved editor text, by path; and the folders closed in the tree.
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string>();
  // The latest state, for edits that finish after an await.
  const loadedRef = useRef<Loaded | undefined>(undefined);
  loadedRef.current = loaded;
  const watchRef = useRef(watch);
  watchRef.current = watch;

  const addLog = useCallback((text: string, level: LogLine["level"] = "info") => {
    setLog((l) => [...l.slice(-400), { id: ++logId, at: Date.now(), text, level }]);
  }, []);

  useEffect(() => {
    const w = new Worker(new URL("../sandbox/runner.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = w;
    // The ServiceWorker next to this page (integrations/sw-worker.mjs): its scope is the sandbox.
    const unhost = hostSitesForWorker(w, {
      serviceWorkerUrl: new URL(
        `${import.meta.env.BASE_URL.replace(/\/?$/, "/")}sw-worker.js`,
        location.href,
      ).href,
    });
    w.addEventListener("message", (e: MessageEvent<FromRunner>) => {
      const m = e.data;
      if (!m || typeof m !== "object" || !("type" in m)) return;
      if (m.type === "log") addLog(m.text, m.level);
      else if (m.type === "phase") {
        if (m.phase === "building") setStatus({ kind: "building" });
        if (m.phase === "stopped") setStatus({ kind: "stopped" });
      } else if (m.type === "running") {
        setStatus({ kind: "running", baseUrl: m.baseUrl, server: m.server, client: m.client });
        setFrameKey((k) => k + 1);
      } else if (m.type === "failed") {
        setStatus({ kind: "failed", error: m.error });
        setTab("log");
      }
    });
    w.addEventListener("error", (e) => addLog(`runner: ${e.message}`, "error"));
    return () => {
      unhost();
      w.terminate();
    };
  }, [addLog]);

  const run = useCallback(
    (l: Loaded) => {
      const msg: ToRunner = { type: "run", files: [...l.files], folderName: l.name };
      setStatus({ kind: "building" });
      addLog(`running ${l.name}: ${l.files.size} files`);
      worker.current?.postMessage(msg);
    },
    [addLog],
  );

  const load = useCallback(
    (l: Loaded) => {
      setLoaded(l);
      setDrafts(new Map());
      setCollapsed(new Set());
      setSaveError(undefined);
      const layout = describeProject(l.files, l.name);
      const first =
        (layout.config?.main && normalizePath(`/${layout.config.main}`)) ??
        layout.wranglerPath ??
        [...l.files.keys()][0];
      setSelected(first);
      setTab("preview");
      run(l);
    },
    [run],
  );

  // Watch the folder (File System Access only): a change on disk reruns the app.
  useEffect(() => {
    const handle = loaded?.folder?.handle;
    if (!watch || !handle || !loaded) return;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const sig = await folderSignature(handle);
        if (sig !== loaded.signature) {
          const { files, signature } = await readFolder(handle);
          addLog("the folder changed on disk");
          const next = { ...loaded, files, signature };
          setLoaded(next);
          run(next);
        }
      } catch (err) {
        addLog(`watching ${loaded.name}: ${(err as Error).message}`, "error");
        setWatch(false);
      } finally {
        busy = false;
      }
    }, WATCH_MS);
    return () => clearInterval(timer);
  }, [watch, loaded, run, addLog]);

  async function openFolder() {
    try {
      if (!picker) return input.current?.click();
      const folder = await pickFolder();
      const { files, signature } = await readFolder(folder.handle as FileSystemDirectoryHandle);
      load({ name: folder.name, files, folder, signature });
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      addLog((err as Error).message, "error");
      setTab("log");
    }
  }

  async function onInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files?.length) return;
    try {
      const { name, files } = await filesFromInput(e.target.files);
      load({ name, files });
    } catch (err) {
      addLog((err as Error).message, "error");
    } finally {
      e.target.value = "";
    }
  }

  async function reread() {
    if (!loaded) return;
    const handle = loaded.folder?.handle;
    if (handle) {
      const { files, signature } = await readFolder(handle);
      const next = { ...loaded, files, signature };
      setLoaded(next);
      run(next);
    } else run(loaded);
  }

  // Edits: applied to the folder on disk first, when it was opened with the File System Access
  // API (the first one asks for write access), then to this tab's copy. Without a folder handle
  // (the sample, or a folder read once) they live in this tab: Download .zip keeps them.
  async function onDisk(op: (handle: FileSystemDirectoryHandle) => Promise<void>) {
    const handle = loadedRef.current?.folder?.handle;
    if (!handle) return;
    if (!(await ensureWritable(handle)))
      throw new EditError("write access to the folder was refused: nothing was changed");
    await op(handle);
  }

  async function commit(ws: Workspace, rerun: boolean) {
    const current = loadedRef.current;
    if (!current) return;
    const handle = current.folder?.handle;
    // The new signature, so the folder watcher does not take this edit for a change on disk.
    const signature = handle ? await folderSignature(handle) : current.signature;
    const next: Loaded = { ...current, files: ws.files, dirs: ws.dirs, signature };
    loadedRef.current = next;
    setLoaded(next);
    if (rerun && watchRef.current) run(next);
  }

  const reveal = (path: string) =>
    setCollapsed((c) => new Set([...c].filter((d) => !`${path}/`.startsWith(`${d}/`))));

  async function createFile(path: string) {
    const current = loadedRef.current;
    if (!current) return;
    const ws = addFile(workspaceOf(current), path);
    await onDisk((h) => writeToFolder(h, path, new Uint8Array()));
    await commit(ws, true);
    reveal(path);
    setSelected(path);
    setTab("files");
  }

  async function createDir(path: string) {
    const current = loadedRef.current;
    if (!current) return;
    const ws = addDir(workspaceOf(current), path);
    await onDisk((h) => mkdirInFolder(h, path));
    await commit(ws, false);
    reveal(path);
    setSelected(path);
  }

  async function movePath(from: string, to: string) {
    const current = loadedRef.current;
    if (!current) return;
    const isDirectory = !current.files.has(from);
    const { ws, moved } = move(workspaceOf(current), from, to);
    await onDisk((h) => moveInFolder(h, from, to, moved, (p) => ws.files.get(p), isDirectory));
    await commit(ws, true);
    const follow = (p: string) =>
      moved.get(p) ?? (p === from || p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p);
    setDrafts((d) => new Map([...d].map(([p, t]) => [follow(p), t])));
    setCollapsed((c) => new Set([...c].map(follow)));
    setSelected((s) => (s ? follow(s) : s));
    reveal(to);
  }

  async function deletePath(path: string) {
    const current = loadedRef.current;
    if (!current) return;
    const { ws, removed } = remove(workspaceOf(current), path);
    await onDisk((h) =>
      removeFromFolder(h, path).catch((err: Error) => {
        if (err.name !== "NotFoundError") throw err;
      }),
    );
    await commit(ws, true);
    setDrafts((d) => new Map([...d].filter(([p]) => !removed.includes(p))));
    setSelected((s) => (s && (s === path || s.startsWith(`${path}/`)) ? undefined : s));
  }

  async function save(path: string) {
    const current = loadedRef.current;
    const text = drafts.get(path);
    if (!current || text === undefined) return;
    try {
      const bytes = encode(text);
      const ws = writeFile(workspaceOf(current), path, bytes);
      await onDisk((h) => writeToFolder(h, path, bytes));
      setDrafts((d) => {
        const next = new Map(d);
        if (next.get(path) === text) next.delete(path);
        return next;
      });
      setSaveError(undefined);
      await commit(ws, true);
    } catch (err) {
      setSaveError((err as Error).message);
      addLog(`saving ${path.slice(1)}: ${(err as Error).message}`, "error");
    }
  }

  function download(files: ProjectFiles, name: string) {
    const entries: [string, Uint8Array][] = [...files].map(([p, b]) => [`${name}${p}`, b]);
    const blob = new Blob([zip(entries) as BlobPart], { type: "application/zip" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const layout = useMemo(
    () => (loaded ? describeProject(loaded.files, loaded.name) : undefined),
    [loaded],
  );
  const running = status.kind === "running" ? status : undefined;
  const previewUrl = running
    ? `${running.baseUrl.replace(/\/$/, "")}/${previewPath.replace(/^\//, "")}`
    : "";

  return (
    <div className="flex h-dvh flex-col">
      <input
        ref={input}
        type="file"
        className="hidden"
        // @ts-expect-error: a non-standard attribute every browser supports
        webkitdirectory=""
        multiple
        onChange={onInput}
      />
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5">
        <a
          href="https://cellb.dev/sandbox/"
          title="About CellB sandbox"
          className="flex items-baseline gap-1.5 font-semibold tracking-tight"
        >
          <span className="text-brand-gradient">CellB</span>
          <span className="text-muted-foreground font-normal">sandbox</span>
        </a>
        {loaded && (
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-sm">{layout?.name}</span>
            <StatusBadge status={status} />
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {loaded && (
            <>
              <label
                className="text-muted-foreground flex items-center gap-1.5 text-sm"
                title={
                  loaded.folder?.handle
                    ? "Rerun the app when a file is saved, here or on disk"
                    : "Rerun the app when a file is saved here"
                }
              >
                <input
                  type="checkbox"
                  checked={watch}
                  onChange={(e) => setWatch(e.target.checked)}
                  className="accent-primary"
                />
                Rerun on save
              </label>
              {status.kind === "running" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => worker.current?.postMessage({ type: "stop" } satisfies ToRunner)}
                >
                  <Square /> <span className="max-sm:sr-only">Stop</span>
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={reread}
                disabled={status.kind === "building"}
              >
                {status.kind === "stopped" || status.kind === "failed" ? <Play /> : <RefreshCw />}
                <span className="max-sm:sr-only">
                  {status.kind === "stopped" || status.kind === "failed" ? "Run" : "Rerun"}
                </span>
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => download(loaded.files, layout?.name ?? loaded.name)}
              >
                <Download /> <span className="max-sm:sr-only">Download .zip</span>
              </Button>
            </>
          )}
          {loaded && (
            <Button size="sm" onClick={openFolder}>
              <FolderOpen /> <span className="max-sm:sr-only">Open folder</span>
            </Button>
          )}
        </div>
      </header>

      {!loaded ? (
        <Welcome
          onOpen={openFolder}
          onSample={() => load({ name: SAMPLE_NAME, files: sampleFiles() })}
          onDownloadSample={() => download(sampleFiles(), SAMPLE_NAME)}
          picker={picker}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="max-h-64 shrink-0 overflow-auto border-b md:max-h-none md:w-64 md:border-r md:border-b-0">
            <FileTree
              ws={workspaceOf(loaded)}
              clientRoot={layout?.clientRoot}
              serverFiles={
                new Set(
                  [
                    layout?.wranglerPath,
                    layout?.config?.main && normalizePath(`/${layout.config.main}`),
                  ].filter(Boolean) as string[],
                )
              }
              selected={selected}
              dirty={new Set(drafts.keys())}
              collapsed={collapsed}
              onToggle={(dir) =>
                setCollapsed((c) => {
                  const next = new Set(c);
                  if (!next.delete(dir)) next.add(dir);
                  return next;
                })
              }
              onCollapseAll={(dirs) => setCollapsed(new Set(dirs))}
              onSelect={(p) => {
                setSelected(p);
                if (loaded.files.has(p)) setTab("files");
              }}
              onCreateFile={createFile}
              onCreateDir={createDir}
              onMove={movePath}
              onDelete={deletePath}
            />
          </aside>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2">
                <TabsList>
                  <TabsTrigger value="preview">
                    <Eye /> Preview
                  </TabsTrigger>
                  <TabsTrigger value="files">
                    <FileCode2 /> Code
                    {drafts.size > 0 && (
                      <span className="bg-primary size-1.5 rounded-full">
                        <span className="sr-only">unsaved changes</span>
                      </span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="log">
                    <ScrollText /> Log
                    {log.some((l) => l.level === "error") && (
                      <span className="bg-destructive size-1.5 rounded-full">
                        <span className="sr-only">has errors</span>
                      </span>
                    )}
                  </TabsTrigger>
                </TabsList>
                {tab === "preview" && running && (
                  <form
                    className="flex min-w-48 flex-1 basis-64 items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setFrameKey((k) => k + 1);
                    }}
                  >
                    <div className="bg-background focus-within:ring-ring/40 flex h-8 min-w-0 flex-1 items-center rounded-md border px-2.5 font-mono text-xs focus-within:ring-2">
                      <span className="text-muted-foreground">/</span>
                      <input
                        aria-label="Path in the app"
                        value={previewPath}
                        onChange={(e) => setPreviewPath(e.target.value.replace(/^\//, ""))}
                        className="min-w-0 flex-1 bg-transparent outline-none"
                        placeholder="api/hello"
                        spellCheck={false}
                      />
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      type="submit"
                      aria-label="Reload the preview"
                    >
                      <RefreshCw />
                    </Button>
                    <Button size="icon" variant="ghost" className="size-8" asChild>
                      <a
                        href={previewUrl}
                        target="_blank"
                        rel="noopener"
                        aria-label="Open in a new tab"
                      >
                        <ExternalLink />
                      </a>
                    </Button>
                  </form>
                )}
              </div>
              <TabsContent
                value="preview"
                className="relative min-h-0"
                forceMount
                hidden={tab !== "preview"}
              >
                {running ? (
                  <iframe
                    key={frameKey}
                    src={previewUrl}
                    title="The running app"
                    className="absolute inset-0 size-full bg-white"
                  />
                ) : (
                  <PreviewPlaceholder status={status} onLog={() => setTab("log")} />
                )}
              </TabsContent>
              <TabsContent value="files" className="flex min-h-0 flex-col">
                {selected && loaded.files.has(selected) ? (
                  <FileEditor
                    path={selected}
                    bytes={loaded.files.get(selected) as Uint8Array}
                    draft={drafts.get(selected)}
                    onDisk={!!loaded.folder?.handle}
                    error={saveError}
                    onChange={(text) =>
                      setDrafts((d) => {
                        const next = new Map(d);
                        const saved = decode(loaded.files.get(selected) as Uint8Array);
                        if (text === saved) next.delete(selected);
                        else next.set(selected, text);
                        return next;
                      })
                    }
                    onSave={() => void save(selected)}
                  />
                ) : (
                  <p className="text-muted-foreground p-6 text-sm">
                    Select a file on the left, or make one with New file.
                  </p>
                )}
              </TabsContent>
              <TabsContent value="log" className="min-h-0 overflow-auto">
                <LogView lines={log} onClear={() => setLog([])} />
              </TabsContent>
            </Tabs>
          </main>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  switch (status.kind) {
    case "building":
      return (
        <Badge variant="secondary" className="gap-1.5">
          <span className="bg-primary size-1.5 animate-pulse rounded-full motion-reduce:animate-none" />
          building
        </Badge>
      );
    case "running":
      return (
        <Badge variant="outline" className="gap-1.5" data-testid="status">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          {status.server && status.client
            ? "client and server running"
            : status.server
              ? "server running"
              : "client running"}
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive">failed</Badge>;
    case "stopped":
      return <Badge variant="outline">stopped</Badge>;
    default:
      return null;
  }
}

function Welcome(props: {
  onOpen(): void;
  onSample(): void;
  onDownloadSample(): void;
  picker: boolean;
}) {
  return (
    <div className="bg-grid flex flex-1 items-center justify-center overflow-auto p-6">
      <div className="bg-card w-full max-w-2xl rounded-xl border p-6 shadow-sm sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Run a full-stack app from a folder, in this tab
        </h1>
        <p className="text-muted-foreground mt-3 max-w-prose">
          Pick a folder on your computer. Its server part runs on CellB, with Durable Objects and
          SQLite in your browser. Its client part is compiled file by file and talks to that server.
          Nothing is uploaded.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Part
            tone="server"
            title="Server"
            path="wrangler.jsonc"
            text="A Workers project: main, Durable Objects, KV, D1, npm packages."
          />
          <Part
            tone="client"
            title="Client"
            path="client/index.html"
            text="An HTML page whose scripts and styles are TS, TSX, JS, JSX or CSS."
          />
        </div>
        <p className="text-muted-foreground mt-4 text-sm">
          The client calls the server with relative URLs, like{" "}
          <code className="bg-muted rounded px-1 font-mono text-xs">fetch("api/tasks")</code>. The
          folder's package.json gives the npm versions.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button onClick={props.onOpen}>
            <FolderOpen /> Open folder
          </Button>
          <Button variant="outline" onClick={props.onSample}>
            <Sparkles /> Try the sample
          </Button>
          <Button variant="ghost" onClick={props.onDownloadSample}>
            <Download /> Download the sample
          </Button>
        </div>
        {!props.picker && (
          <p className="text-muted-foreground mt-4 text-xs">
            This browser has no folder access API, so the folder is read once. Use Chrome or Edge to
            rerun the app when you save a file.
          </p>
        )}
      </div>
    </div>
  );
}

function Part(props: { tone: "server" | "client"; title: string; path: string; text: string }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-l-4 p-4",
        props.tone === "server" ? "border-l-accent-2" : "border-l-primary",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{props.title}</span>
        <span className="text-muted-foreground font-mono text-xs">{props.path}</span>
      </div>
      <p className="text-muted-foreground mt-1.5 text-sm">{props.text}</p>
    </div>
  );
}

const TEXT = /\.(?:[cm]?[jt]sx?|json[c5]?|html?|css|md|txt|svg|toml|ya?ml|sql|gitignore|env)$/i;

/** Shown as text: a known text extension, or bytes that decode as UTF-8 with no NUL. */
function textOf(path: string, bytes: Uint8Array): string | undefined {
  if (bytes.length > 1024 * 1024) return undefined;
  if (TEXT.test(path)) return decode(bytes);
  if (bytes.subarray(0, 8192).includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function FileEditor(props: {
  path: string;
  bytes: Uint8Array;
  draft?: string;
  onDisk: boolean;
  error?: string;
  onChange(text: string): void;
  onSave(): void;
}) {
  const text = textOf(props.path, props.bytes);
  const dirty = props.draft !== undefined;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5">
        <span className="min-w-0 truncate font-mono text-xs">{props.path.slice(1)}</span>
        <span className="text-muted-foreground text-xs">
          {dirty ? "unsaved" : `${props.bytes.length.toLocaleString()} bytes`}
          {" · "}
          {props.onDisk
            ? "saves to the folder on disk"
            : "saves in this tab (Download .zip keeps it)"}
        </span>
        {props.error && (
          <span role="alert" className="text-destructive text-xs">
            {props.error}
          </span>
        )}
        <Button
          size="sm"
          variant={dirty ? "default" : "outline"}
          className="ml-auto h-7"
          disabled={!dirty || text === undefined}
          onClick={props.onSave}
          title="Save (Ctrl/Cmd+S)"
        >
          <Save /> Save
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {text !== undefined ? (
          <div className="absolute inset-0">
            <CodeEditor
              key={props.path}
              path={props.path}
              value={props.draft ?? text}
              onChange={props.onChange}
              onSave={props.onSave}
            />
          </div>
        ) : (
          <p className="text-muted-foreground p-4 text-sm">
            A binary or large file ({props.bytes.length.toLocaleString()} bytes): not editable here.
          </p>
        )}
      </div>
    </>
  );
}

function LogView({ lines, onClear }: { lines: LogLine[]; onClear(): void }) {
  const end = useRef<HTMLDivElement>(null);
  const count = lines.length;
  useEffect(() => {
    if (count) end.current?.scrollIntoView({ block: "end" });
  }, [count]);
  return (
    <div className="font-mono text-[12.5px] leading-6">
      <div className="bg-background sticky top-0 flex justify-end border-b px-3 py-1.5">
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      </div>
      <ol className="px-4 py-2" data-testid="log">
        {lines.map((l) => (
          <li
            key={l.id}
            className={cn("whitespace-pre-wrap", l.level === "error" && "text-destructive")}
          >
            <span className="text-muted-foreground mr-3 tabular-nums">
              {new Date(l.at).toLocaleTimeString([], { hour12: false })}
            </span>
            {l.text}
          </li>
        ))}
      </ol>
      <div ref={end} />
    </div>
  );
}

function PreviewPlaceholder({ status, onLog }: { status: Status; onLog(): void }) {
  return (
    <div className="text-muted-foreground flex h-full min-h-64 flex-col items-center justify-center gap-3 p-6 text-sm">
      {status.kind === "building" && <p>Compiling the server and starting it on CellB…</p>}
      {status.kind === "failed" && (
        <>
          <p className="text-destructive max-w-prose text-center">{status.error}</p>
          <Button size="sm" variant="outline" onClick={onLog}>
            Show the log
          </Button>
        </>
      )}
      {status.kind === "stopped" && <p>The app is stopped. Press Run to start it again.</p>}
    </div>
  );
}
