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
  ScrollText,
  Sparkles,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  canPickFolder,
  filesFromInput,
  folderSignature,
  type LocalFolder,
  pickFolder,
  readFolder,
} from "@/sandbox/folder";
import { decode, describeProject, normalizePath, type ProjectFiles } from "@/sandbox/project";
import type { FromRunner, ToRunner } from "@/sandbox/protocol";
import { SAMPLE_NAME, sampleFiles } from "@/sandbox/sample";

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
  folder?: LocalFolder;
  signature?: string;
}

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

  const addLog = useCallback((text: string, level: LogLine["level"] = "info") => {
    setLog((l) => [...l.slice(-400), { id: ++logId, at: Date.now(), text, level }]);
  }, []);

  useEffect(() => {
    const w = new Worker(new URL("../sandbox/runner.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = w;
    const unhost = hostSitesForWorker(w);
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
          href="https://cellb.dev"
          className="flex items-baseline gap-1.5 font-semibold tracking-tight"
        >
          <span className="text-brand-gradient">cellb</span>
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
              {loaded.folder?.handle && (
                <label className="text-muted-foreground flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={watch}
                    onChange={(e) => setWatch(e.target.checked)}
                    className="accent-primary"
                  />
                  Rerun on save
                </label>
              )}
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
          <aside className="max-h-56 shrink-0 overflow-auto border-b md:max-h-none md:w-64 md:border-r md:border-b-0">
            <FileTree
              files={loaded.files}
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
              onSelect={(p) => {
                setSelected(p);
                setTab("files");
              }}
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
                    <FileCode2 /> Files
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
              <TabsContent value="files" className="min-h-0 overflow-auto">
                {selected && loaded.files.has(selected) ? (
                  <FileView path={selected} bytes={loaded.files.get(selected) as Uint8Array} />
                ) : (
                  <p className="text-muted-foreground p-6 text-sm">Select a file on the left.</p>
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

interface TreeRow {
  path: string;
  name: string;
  depth: number;
  dir: boolean;
}

/** Folders first, then files, each sorted by name; a folder row before its contents. */
function treeRows(paths: string[]): TreeRow[] {
  type Node = { dirs: Map<string, Node>; files: string[] };
  const root: Node = { dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    let n = root;
    for (const d of parts.slice(0, -1)) {
      if (!n.dirs.has(d)) n.dirs.set(d, { dirs: new Map(), files: [] });
      n = n.dirs.get(d) as Node;
    }
    n.files.push(p);
  }
  const rows: TreeRow[] = [];
  const walk = (n: Node, prefix: string, depth: number) => {
    for (const [name, child] of [...n.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      rows.push({ path: `${prefix}/${name}`, name, depth, dir: true });
      walk(child, `${prefix}/${name}`, depth + 1);
    }
    for (const f of n.files.sort())
      rows.push({ path: f, name: f.slice(f.lastIndexOf("/") + 1), depth, dir: false });
  };
  walk(root, "", 0);
  return rows;
}

function FileTree(props: {
  files: ProjectFiles;
  clientRoot?: string;
  serverFiles: Set<string>;
  selected?: string;
  onSelect(path: string): void;
}) {
  const rows = treeRows([...props.files.keys()]);
  const inClient = (p: string) =>
    !!props.clientRoot &&
    (props.clientRoot === "/" || p === props.clientRoot || p.startsWith(`${props.clientRoot}/`));
  const roleOf = (p: string) =>
    props.serverFiles.has(p) ? "server" : inClient(p) ? "client" : undefined;
  return (
    <nav aria-label="Project files" className="py-2">
      <ul className="font-mono text-[13px]">
        {rows.map((r) => {
          const role = roleOf(r.path);
          const rail = cn(
            "flex w-full items-center gap-1.5 border-l-2 border-transparent py-1 pr-3 text-left",
            role === "server" && "border-l-accent-2",
            role === "client" && "border-l-primary/60",
          );
          const indent = { paddingLeft: `${12 + r.depth * 14}px` };
          if (r.dir)
            return (
              <li key={r.path} className={cn(rail, "text-muted-foreground")} style={indent}>
                <FolderOpen className="size-3.5 shrink-0" aria-hidden />
                {r.name}
                {role === "client" && r.path === props.clientRoot && (
                  <span className="text-primary ml-auto font-sans text-[11px]">client</span>
                )}
              </li>
            );
          return (
            <li key={r.path}>
              <button
                type="button"
                onClick={() => props.onSelect(r.path)}
                aria-current={props.selected === r.path ? "true" : undefined}
                className={cn(
                  rail,
                  "hover:bg-accent",
                  props.selected === r.path && "bg-accent text-accent-foreground",
                )}
                style={indent}
                title={role ? `${r.path.slice(1)} (${role})` : r.path.slice(1)}
              >
                <span className="truncate">{r.name}</span>
                {role === "server" && (
                  <span className="text-accent-2 ml-auto shrink-0 font-sans text-[11px]">
                    server
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const TEXT = /\.(?:[cm]?[jt]sx?|json[c5]?|html?|css|md|txt|svg|toml|ya?ml|sql|gitignore)$/i;

function FileView({ path, bytes }: { path: string; bytes: Uint8Array }) {
  const text = TEXT.test(path) && bytes.length < 512 * 1024 ? decode(bytes) : undefined;
  return (
    <div>
      <div className="text-muted-foreground border-b px-4 py-2 font-mono text-xs">
        {path.slice(1)}, {bytes.length.toLocaleString()} bytes, read only
      </div>
      {text !== undefined ? (
        <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-6">{text}</pre>
      ) : (
        <p className="text-muted-foreground p-4 text-sm">A binary or large file: not shown.</p>
      )}
    </div>
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
