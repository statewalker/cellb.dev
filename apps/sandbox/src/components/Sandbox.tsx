import { hostSitesForWorker } from "@statewalker/cellb/site";
import { zip } from "@statewalker/cellb-platform-core/util";
import {
  Bot,
  Download,
  ExternalLink,
  Eye,
  FileCode2,
  FolderOpen,
  Play,
  RefreshCw,
  Rocket,
  Save,
  ScrollText,
  Sparkles,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentPanel } from "@/components/AgentPanel";
import { CodeEditor } from "@/components/CodeEditor";
import { FileTree } from "@/components/FileTree";
import { type Build, ShipPanel } from "@/components/ShipPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { type PublishedTools, publishTools } from "@/sandbox/agent/bridge";
import { createFlueAgent } from "@/sandbox/agent/flue";
import {
  callTool,
  createTools,
  type RunState,
  type StudioHost,
  type TreeItem,
} from "@/sandbox/agent/tools";
import { canPickFolder, ensureWritable, filesFromInput, pickFolder } from "@/sandbox/folder";
import {
  decode,
  describeProject,
  encode,
  normalizePath,
  type ProjectFiles,
  SKIPPED_DIRS,
} from "@/sandbox/project";
import type { FromRunner, ToRunner } from "@/sandbox/protocol";
import { SAMPLE_NAME, sampleFiles } from "@/sandbox/sample";
import {
  type AgentMode,
  connectStudio,
  openProjectSession,
  type ProjectSession,
  projectSignature,
  readProject,
  type StudioConnection,
} from "@/sandbox/session";
import { describeSource, type SourceSpec } from "@/sandbox/sources";
import type { FromStudio, ToStudio } from "@/sandbox/studio-protocol";
import { TEMPLATES } from "@/sandbox/templates";
import {
  addDir,
  addFile,
  EditError,
  move,
  remove,
  type Workspace,
  writeFile,
} from "@/sandbox/workspace";
import { files as capFiles, TokenCap } from "../../studio/src/capfs/token-cap";

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
  /** This tab's view of the files: what the owner capability read last. */
  files: ProjectFiles;
  /** Folders with no file in them yet (made in the tree). */
  dirs?: Set<string>;
  /** The project's files in the studio worker, and the capabilities on them. */
  session: ProjectSession;
  /** A folder on disk: its handle, for write access (asked for in a click). */
  handle?: FileSystemDirectoryHandle;
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
  // The tree's selection (a file or a folder: where new things go) and the file in the editor
  // (the last file selected; selecting a folder keeps it).
  const [selected, setSelected] = useState<string>();
  const [openFile, setOpenFile] = useState<string>();
  const [watch, setWatch] = useState(true);
  const [previewPath, setPreviewPath] = useState("");
  const [frameKey, setFrameKey] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const picker = useMemo(canPickFolder, []);
  // Unsaved editor text, by path; and the folders closed in the tree.
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<{ path: string; message: string }>();
  // The latest state, for edits that finish after an await.
  const loadedRef = useRef<Loaded | undefined>(undefined);
  loadedRef.current = loaded;
  const watchRef = useRef(watch);
  watchRef.current = watch;
  // Edits run one at a time, each on the state the one before left (see `edit`).
  const editQueue = useRef<Promise<unknown>>(Promise.resolve());
  const editsInFlight = useRef(0);
  const editCount = useRef(0);
  // For the agent tools: the latest status and log, and who waits for a run or a build to end.
  const statusRef = useRef<Status>(status);
  statusRef.current = status;
  const logRef = useRef<LogLine[]>(log);
  logRef.current = log;
  const runWaiters = useRef<((s: RunState) => void)[]>([]);
  const builds = useRef(new Map<number, { resolve(b: Build): void; reject(e: Error): void }>());
  const buildId = useRef(0);
  const [published, setPublished] = useState<PublishedTools>();
  // The studio worker (the project's files, the capabilities, the Flue agents).
  const studioRef = useRef<StudioConnection | null>(null);
  const toolsRef = useRef<ReturnType<typeof createTools> | null>(null);
  // The rights the IDE's tools give agents outside the page (window.cellbSandbox, WebMCP, MCP).
  const [outsideMode, setOutsideMode] = useState<AgentMode>("yolo");
  const outsideModeRef = useRef(outsideMode);
  outsideModeRef.current = outsideMode;
  // Asks the watcher to look now (a change notice from the studio, a write by a tool).
  const checkSoon = useRef<() => void>(() => {});

  const addLog = useCallback((text: string, level: LogLine["level"] = "info") => {
    const line = { id: ++logId, at: Date.now(), text, level };
    logRef.current = [...logRef.current.slice(-400), line];
    setLog((l) => [...l.slice(-400), line]);
  }, []);

  useEffect(() => {
    const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");
    // The studio worker owns the project's files and runs the studio Worker (Flue agents) on
    // CellB; the runner builds and runs the app, reading the files through a capability.
    const sw = new Worker(new URL("../sandbox/studio.worker.ts", import.meta.url), {
      type: "module",
    });
    const studio = connectStudio(
      sw,
      new URL(`${base}studio/`, location.href).href,
      (m: FromStudio) => {
        if (m.type === "changed") checkSoon.current();
        else if (m.type === "log") addLog(m.text, m.level);
        else if (m.type === "host-call") {
          // The studio's agent wants the app run, its log or a request: the page's tools act.
          void callTool(toolsRef.current ?? [], m.tool, m.args).then((out) =>
            sw.postMessage({ type: "host-reply", id: m.id, out } satisfies ToStudio),
          );
        }
      },
    );
    studioRef.current = studio;
    sw.addEventListener("error", (e) => addLog(`studio: ${e.message}`, "error"));

    const w = new Worker(new URL("../sandbox/runner.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = w;
    const port = studio.portForRunner();
    w.postMessage({ type: "studio-port", port } satisfies ToRunner, [port]);
    // The ServiceWorker next to this page (integrations/sw-worker.mjs): its scope is the sandbox.
    const unhost = hostSitesForWorker(w, {
      serviceWorkerUrl: new URL(`${base}sw-worker.js`, location.href).href,
    });
    w.addEventListener("message", (e: MessageEvent<FromRunner>) => {
      const m = e.data;
      if (!m || typeof m !== "object" || !("type" in m)) return;
      if (m.type === "log") addLog(m.text, m.level);
      else if (m.type === "phase") {
        if (m.phase === "building") setStatus({ kind: "building" });
        if (m.phase === "stopped") setStatus({ kind: "stopped" });
      } else if (m.type === "running") {
        const next: Status = {
          kind: "running",
          baseUrl: m.baseUrl,
          server: m.server,
          client: m.client,
        };
        statusRef.current = next;
        setStatus(next);
        setFrameKey((k) => k + 1);
        for (const w of runWaiters.current.splice(0)) w(next);
      } else if (m.type === "failed") {
        const next: Status = { kind: "failed", error: m.error };
        statusRef.current = next;
        setStatus(next);
        setTab((t) => (t === "agent" ? t : "log"));
        for (const w of runWaiters.current.splice(0)) w(next);
      } else if (m.type === "built") {
        builds.current.get(m.id)?.resolve({ files: new Map(m.files), summary: m.summary });
        builds.current.delete(m.id);
      } else if (m.type === "build-failed") {
        builds.current.get(m.id)?.reject(new Error(m.error));
        builds.current.delete(m.id);
      }
    });
    w.addEventListener("error", (e) => addLog(`runner: ${e.message}`, "error"));
    return () => {
      unhost();
      w.terminate();
      sw.terminate();
    };
  }, [addLog]);

  const run = useCallback(
    (l: Loaded) => {
      // The runner reads the files itself, through the session's read-only capability.
      const msg: ToRunner = {
        type: "run",
        workspace: l.session.ws,
        token: l.session.buildToken,
        folderName: l.name,
      };
      statusRef.current = { kind: "building" };
      setStatus({ kind: "building" });
      addLog(`running ${l.name}: ${l.files.size} files (${describeSource(l.session.source)})`);
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
      setOpenFile(first);
      setTab("preview");
      run(l);
    },
    [run],
  );

  // Watch the files (any source: the folder on disk, OPFS, S3…): a change made elsewhere (on
  // disk, by an agent, by another tab) refreshes the tree and reruns the app. It compares the
  // tree's sizes and dates (one capability call), pauses while an edit of this tab is under way,
  // and drops a reading that an edit overtook: that edit already brought the change, and the
  // reading may have caught it halfway (a move copied, not yet removed). The studio's change
  // notices make it look at once.
  const session = loaded?.session;
  useEffect(() => {
    if (!session) return;
    let busy = false;
    let again = false;
    let alive = true;
    const check = async () => {
      const start = loadedRef.current;
      if (!alive || !start || start.session !== session) return;
      if (busy || editsInFlight.current > 0) {
        again = true;
        return;
      }
      busy = true;
      const edits = editCount.current;
      const overtaken = () =>
        !alive ||
        editsInFlight.current > 0 ||
        editCount.current !== edits ||
        loadedRef.current !== start;
      try {
        const sig = await projectSignature(session);
        if (sig === start.signature || overtaken()) return;
        const { files, dirs, signature } = await readProject(session);
        if (overtaken()) return;
        addLog("the files changed");
        const next = { ...start, files, dirs, signature };
        loadedRef.current = next;
        setLoaded(next);
        if (watchRef.current) run(next);
      } catch (err) {
        addLog(`watching ${start.name}: ${(err as Error).message}`, "error");
      } finally {
        busy = false;
        if (again) {
          again = false;
          setTimeout(check, 50);
        }
      }
    };
    let soon: ReturnType<typeof setTimeout> | undefined;
    checkSoon.current = () => {
      clearTimeout(soon);
      soon = setTimeout(check, 150);
    };
    const timer = setInterval(check, WATCH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      clearTimeout(soon);
      checkSoon.current = () => {};
    };
  }, [session, run, addLog]);

  /** Opens a project: its files mounted in the studio worker, read through the owner token. */
  async function openProject(name: string, source: SourceSpec, handle?: FileSystemDirectoryHandle) {
    const studio = studioRef.current;
    if (!studio) throw new Error("the studio is not ready");
    const before = loadedRef.current?.session;
    const s = await openProjectSession(studio, name, source);
    const { files, dirs, signature } = await readProject(s);
    if (before) studio.unmount(before.ws);
    load({ name, files, dirs, session: s, handle, signature });
  }

  async function openFolder() {
    if (!mayDiscard()) return;
    try {
      if (!picker) return input.current?.click();
      const folder = await pickFolder();
      const handle = folder.handle as FileSystemDirectoryHandle;
      await openProject(folder.name, { kind: "folder", handle }, handle);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      addLog((err as Error).message, "error");
      setTab("log");
    }
  }

  /** Opens files given as a list (a template, a ZIP, a GitHub branch…), kept in memory. */
  async function openMemory(name: string, files: ProjectFiles) {
    try {
      await openProject(name, { kind: "memory", files: [...files] });
    } catch (err) {
      addLog((err as Error).message, "error");
      setTab("log");
    }
  }

  async function openSourceSpec(name: string, source: SourceSpec) {
    if (!mayDiscard()) return;
    try {
      await openProject(name, source);
    } catch (err) {
      addLog(`opening ${describeSource(source)}: ${(err as Error).message}`, "error");
      setTab("log");
    }
  }

  async function onInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files?.length) return;
    try {
      const { name, files } = await filesFromInput(e.target.files);
      await openMemory(name, files);
    } catch (err) {
      addLog((err as Error).message, "error");
    } finally {
      e.target.value = "";
    }
  }

  async function reread() {
    const current = loadedRef.current;
    if (!current) return;
    const { files, dirs, signature } = await readProject(current.session);
    const next = { ...current, files, dirs, signature };
    loadedRef.current = next;
    setLoaded(next);
    run(next);
  }

  // Edits: through the owner capability, on the project's files wherever they are (the folder on
  // disk, memory, OPFS, S3…), then to this tab's view.
  //
  // Write access to a folder on disk is asked for at once, in the click or key that makes the
  // edit (the browser shows its prompt only then). The edit itself waits in a queue, so that
  // each one starts from the state the one before left: two quick edits never write over each
  // other.
  async function edit(
    op: (current: Loaded, fs: Loaded["session"]["fs"]) => Promise<Workspace>,
    { rerun, after }: { rerun: boolean; after?: () => void },
  ): Promise<void> {
    const handle = loadedRef.current?.handle;
    if (handle && !(await ensureWritable(handle)))
      throw new EditError("write access to the folder was refused: nothing was changed");
    const task = editQueue.current.then(async () => {
      const current = loadedRef.current;
      if (!current) return;
      editsInFlight.current++;
      editCount.current++;
      try {
        const ws = await op(current, current.session.fs);
        // The new files first, with what goes with them (drafts, selection) in the same render.
        let next: Loaded = { ...current, files: ws.files, dirs: ws.dirs };
        loadedRef.current = next;
        setLoaded(next);
        after?.();
        // Then the files' new signature, so the watcher does not take this edit for a change.
        const signature = await projectSignature(current.session);
        next = { ...(loadedRef.current ?? next), signature };
        loadedRef.current = next;
        setLoaded(next);
        if (rerun && watchRef.current) run(next);
      } finally {
        editsInFlight.current--;
      }
    });
    editQueue.current = task.catch(() => {});
    return task;
  }

  /** Nothing may be there, also what the view leaves out (node_modules, .git…). */
  async function assertAbsent(fs: Loaded["session"]["fs"], path: string) {
    if (await fs.exists(path)) throw new EditError(`${path.slice(1)} already exists`);
  }

  const reveal = (path: string) =>
    setCollapsed((c) => new Set([...c].filter((d) => !`${path}/`.startsWith(`${d}/`))));

  const createFile = (path: string) =>
    edit(
      async (current, fs) => {
        const ws = addFile(workspaceOf(current), path);
        await assertAbsent(fs, path);
        await fs.write(path, [new Uint8Array()]);
        return ws;
      },
      {
        rerun: true,
        after: () => {
          reveal(path);
          setSelected(path);
          setOpenFile(path);
          setTab("files");
        },
      },
    );

  const createDir = (path: string) =>
    edit(
      async (current, fs) => {
        const ws = addDir(workspaceOf(current), path);
        await assertAbsent(fs, path);
        await fs.mkdir(path);
        return ws;
      },
      {
        rerun: false,
        after: () => {
          reveal(path);
          setSelected(path);
        },
      },
    );

  const movePath = (from: string, to: string) => {
    const follow = (p: string) =>
      p === from || p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p;
    return edit(
      async (current, fs) => {
        const { ws } = move(workspaceOf(current), from, to);
        if (from.toLowerCase() === to.toLowerCase()) {
          // A disk that ignores case would take the new name for the old file.
          const step = `${to}.sandbox-move-${Date.now().toString(36)}`;
          await fs.move(from, step);
          await fs.move(step, to);
        } else {
          await assertAbsent(fs, to);
          if (!(await fs.move(from, to)))
            throw new EditError(`${from.slice(1)} is not in the project's files`);
        }
        return ws;
      },
      {
        rerun: true,
        after: () => {
          setDrafts((d) => new Map([...d].map(([p, t]) => [follow(p), t])));
          setCollapsed((c) => new Set([...c].map(follow)));
          setSelected((s) => (s ? follow(s) : s));
          setOpenFile((s) => (s ? follow(s) : s));
          setSaveError((e) => (e ? { ...e, path: follow(e.path) } : e));
          reveal(to);
        },
      },
    );
  };

  const deletePath = (path: string) => {
    const under = (p: string) => p === path || p.startsWith(`${path}/`);
    return edit(
      async (current, fs) => {
        const { ws } = remove(workspaceOf(current), path);
        await fs.remove(path);
        return ws;
      },
      {
        rerun: true,
        after: () => {
          setDrafts((d) => new Map([...d].filter(([p]) => !under(p))));
          setSelected((s) => (s && under(s) ? undefined : s));
          setOpenFile((s) => (s && under(s) ? undefined : s));
        },
      },
    );
  };

  async function save(path: string) {
    const text = drafts.get(path);
    if (text === undefined) return;
    const bytes = encode(text);
    try {
      await edit(
        async (current, fs) => {
          const ws = writeFile(workspaceOf(current), path, bytes);
          await fs.write(path, [bytes]);
          return ws;
        },
        {
          rerun: true,
          // Cleared with the new bytes in the same render, and only if nothing was typed since:
          // the editor never shows the old text in between.
          after: () => {
            setDrafts((d) => {
              if (d.get(path) !== text) return d;
              const next = new Map(d);
              next.delete(path);
              return next;
            });
            setSaveError((e) => (e?.path === path ? undefined : e));
          },
        },
      );
    } catch (err) {
      setSaveError({ path, message: (err as Error).message });
      addLog(`saving ${path.slice(1)}: ${(err as Error).message}`, "error");
    }
  }

  // Ctrl/Cmd+S anywhere on the page saves the open file (not the browser's "Save page as").
  const saveRef = useRef(save);
  saveRef.current = save;
  const openRef = useRef(openFile);
  openRef.current = openFile;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s" || e.altKey) return;
      e.preventDefault();
      if (openRef.current) void saveRef.current(openRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Unsaved edits: the browser asks before the tab closes or reloads, and opening another
  // project asks first.
  const unsaved = drafts.size > 0;
  useEffect(() => {
    if (!unsaved) return;
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [unsaved]);
  const mayDiscard = () =>
    !unsaved ||
    confirm(
      `Discard the unsaved changes in ${drafts.size === 1 ? "1 file" : `${drafts.size} files`}?`,
    );

  function download(files: ProjectFiles, name: string) {
    const entries: [string, Uint8Array][] = [...files].map(([p, b]) => [`${name}${p}`, b]);
    const blob = new Blob([zip(entries) as BlobPart], { type: "application/zip" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // The IDE's tools for agents outside the page (agent/tools.ts, published as
  // window.cellbSandbox, WebMCP and MCP): they hold a capability of their own, with the rights
  // chosen in the Agent tab, and read and write through it, so a read-only mode holds for them
  // too. Their writes show here as any change does (the studio's notices, the watcher). Agent
  // edits do not rerun the app on their own: the agent runs it (run_app) when its change is
  // complete.
  const outsideFs = async () => {
    const l = loadedRef.current;
    if (!l) throw new Error("no project is open");
    const token = await l.session.tokenFor(outsideModeRef.current);
    const cap = new TokenCap(studioRef.current?.send as never, l.session.ws, token);
    return { cap, fs: capFiles(cap) };
  };
  const after = async <T,>(p: Promise<T>) => {
    const out = await p;
    checkSoon.current();
    return out;
  };
  const hostImpl = useRef<StudioHost>(null as unknown as StudioHost);
  hostImpl.current = {
    project: () => {
      const l = loadedRef.current;
      return (
        l && {
          name: l.name,
          source: describeSource(l.session.source),
          rights: outsideModeRef.current,
        }
      );
    },
    tree: async (opts = {}) => {
      const { cap } = await outsideFs();
      const tree = await cap.readTree("/", {
        contents: opts.contents,
        dirs: true,
        skip: [...SKIPPED_DIRS],
      });
      return tree.map((e): TreeItem => ({ path: e.path, size: e.size, dir: e.dir, data: e.data }));
    },
    read: async (path) => {
      const { fs } = await outsideFs();
      if (!(await fs.exists(path))) return undefined;
      const chunks: Uint8Array[] = [];
      for await (const c of fs.read(path)) chunks.push(c);
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    },
    writeFile: async (path, bytes) => {
      const { fs } = await outsideFs();
      await after(fs.write(path, [bytes]));
      reveal(path);
    },
    mkdir: async (path) => {
      const { fs } = await outsideFs();
      await after(fs.mkdir(path));
    },
    remove: async (path) => {
      const { fs } = await outsideFs();
      if (!(await after(fs.remove(path)))) throw new Error(`${path.slice(1)} does not exist`);
    },
    move: async (from, to) => {
      const { fs } = await outsideFs();
      if (await fs.exists(to)) throw new Error(`${to.slice(1)} already exists`);
      if (!(await after(fs.move(from, to)))) throw new Error(`${from.slice(1)} does not exist`);
    },
    run: async () => {
      await editQueue.current;
      // The latest files first (an agent's writes), then the run.
      const current = loadedRef.current;
      if (!current) throw new Error("no project is open");
      const { files, dirs, signature } = await readProject(current.session);
      const l = { ...(loadedRef.current ?? current), files, dirs, signature };
      loadedRef.current = l;
      setLoaded(l);
      const done = new Promise<RunState>((resolve) => {
        runWaiters.current.push(resolve);
        setTimeout(() => resolve(statusRef.current), 180_000);
      });
      run(l);
      return done;
    },
    stop: async () => {
      worker.current?.postMessage({ type: "stop" } satisfies ToRunner);
    },
    state: () => statusRef.current,
    logs: () => logRef.current,
    fetchApp: (path, init) => {
      const s = statusRef.current;
      if (s.kind !== "running") throw new Error("the app is not running");
      return fetch(`${s.baseUrl.replace(/\/$/, "")}/${path}`, init);
    },
    reveal: (path) => {
      reveal(path);
      setSelected(path);
      setOpenFile(path);
    },
  };
  const tools = useMemo(() => {
    const host: StudioHost = new Proxy({} as StudioHost, {
      get: (_t, key) => hostImpl.current[key as keyof StudioHost],
    });
    return createTools(host);
  }, []);
  const getTools = useCallback(() => tools, [tools]);
  toolsRef.current = tools;

  useEffect(() => {
    let alive = true;
    let pub: PublishedTools | undefined;
    publishTools(getTools, {
      serviceWorkerUrl: new URL(
        `${import.meta.env.BASE_URL.replace(/\/?$/, "/")}sw-worker.js`,
        location.href,
      ).href,
    }).then((p) => {
      pub = p;
      if (alive) setPublished(p);
      else void p.dispose();
    });
    return () => {
      alive = false;
      void pub?.dispose();
    };
  }, [getTools]);

  /** A deployable folder of the project (runner: buildProject + the exported client). */
  const buildDeploy = (): Promise<Build> => {
    const l = loadedRef.current;
    if (!l) return Promise.reject(new Error("no project is open"));
    const id = ++buildId.current;
    return new Promise<Build>((resolve, reject) => {
      builds.current.set(id, { resolve, reject });
      worker.current?.postMessage({
        type: "build",
        id,
        workspace: l.session.ws,
        token: l.session.buildToken,
        folderName: l.name,
      } satisfies ToRunner);
    });
  };

  // The Flue agent's client: the studio worker runs it on CellB (studio/ is built into
  // <base>studio/), on a token of the session with the rights chosen in the Agent tab.
  const flue = useMemo(
    () =>
      createFlueAgent({
        studio: {
          request: (path, init) =>
            studioRef.current?.request(path, init) ??
            Promise.resolve({ status: 503, error: "the studio is not ready" }),
        },
        project: () => loadedRef.current?.session,
        instructions: () => {
          const bytes = loadedRef.current?.files.get("/AGENTS.md");
          return bytes ? decode(bytes) : undefined;
        },
      }),
    [],
  );

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
                  "Rerun the app when a file is saved, here or where the files are (disk, an agent, another tab)"
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
          onTemplate={(id) => {
            const t = TEMPLATES.find((x) => x.id === id);
            if (t && mayDiscard()) void openMemory(t.id, t.files());
          }}
          onSource={(name, source) => void openSourceSpec(name, source)}
          onSample={() => mayDiscard() && void openMemory(SAMPLE_NAME, sampleFiles())}
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
                if (loaded.files.has(p)) {
                  setOpenFile(p);
                  setTab("files");
                }
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
                <TabsList className="max-w-full justify-start overflow-x-auto">
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
                  <TabsTrigger value="agent">
                    <Bot /> Agent
                  </TabsTrigger>
                  <TabsTrigger value="ship">
                    <Rocket /> Ship
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
                {openFile && loaded.files.has(openFile) ? (
                  <FileEditor
                    path={openFile}
                    bytes={loaded.files.get(openFile) as Uint8Array}
                    draft={drafts.get(openFile)}
                    where={describeSource(loaded.session.source)}
                    error={saveError?.path === openFile ? saveError.message : undefined}
                    onChange={(text) =>
                      setDrafts((d) => {
                        const next = new Map(d);
                        const saved = decode(loaded.files.get(openFile) as Uint8Array);
                        if (text === saved) next.delete(openFile);
                        else next.set(openFile, text);
                        return next;
                      })
                    }
                    onSave={() => void save(openFile)}
                  />
                ) : (
                  <p className="text-muted-foreground p-6 text-sm">
                    Select a file on the left, or make one with New file.
                  </p>
                )}
              </TabsContent>
              <TabsContent value="agent" className="min-h-0" forceMount hidden={tab !== "agent"}>
                <AgentPanel
                  agent={flue}
                  hasProject={!!loaded}
                  mcpUrl={published?.mcpUrl}
                  webmcp={!!published?.webmcp}
                  outsideMode={outsideMode}
                  onOutsideMode={setOutsideMode}
                  prepare={async () => {
                    const h = loadedRef.current?.handle;
                    if (h && !(await ensureWritable(h)))
                      throw new Error("write access to the folder was refused");
                  }}
                />
              </TabsContent>
              <TabsContent value="ship" className="min-h-0 overflow-auto">
                <ShipPanel
                  name={layout?.name ?? loaded.name}
                  files={() => loadedRef.current?.files ?? new Map()}
                  build={buildDeploy}
                  download={download}
                  onPulled={(name, files) => mayDiscard() && void openMemory(name, files)}
                  log={addLog}
                />
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
  onTemplate(id: string): void;
  onSource(name: string, source: SourceSpec): void;
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
        <div className="mt-6 border-t pt-4">
          <h2 className="text-sm font-medium">Start from a template</h2>
          <ul className="mt-2 grid gap-2">
            {TEMPLATES.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="hover:bg-muted w-full rounded-md border px-3 py-2 text-left"
                  onClick={() => props.onTemplate(t.id)}
                  aria-label={`Template: ${t.title}`}
                >
                  <span className="block text-sm font-medium">{t.title}</span>
                  <span className="text-muted-foreground block text-xs">{t.description}</span>
                </button>
              </li>
            ))}
          </ul>
          <OtherSources onSource={props.onSource} />
          <p className="text-muted-foreground mt-3 text-xs">
            Every template has an AGENTS.md. The Agent tab works on the open project with your own
            model key; outside agents get the same tools through{" "}
            <code className="font-mono">window.cellbSandbox</code>, WebMCP or MCP.
          </p>
        </div>
        {!props.picker && (
          <p className="text-muted-foreground mt-4 text-xs">
            This browser has no folder access API, so the folder is read once and edits stay in this
            tab. Use Chrome or Edge to write edits back to the folder and rerun on changes made on
            disk.
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
  /** Where saves go (the source's label). */
  where: string;
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
          {`saves to ${props.where}`}
          <span className="max-md:hidden">{" · Tab indents; Esc then Tab leaves the editor"}</span>
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

/** Projects kept elsewhere: the browser's own storage (OPFS), or an S3 bucket. */
function OtherSources(props: { onSource(name: string, source: SourceSpec): void }) {
  const [opfs, setOpfs] = useState("projects/my-app");
  const [s3, setS3] = useState({
    endpoint: "",
    region: "",
    bucket: "",
    prefix: "",
    accessKeyId: "",
    secretAccessKey: "",
  });
  const field = "bg-background h-8 rounded-md border px-2 font-mono text-xs";
  return (
    <div className="mt-4 grid gap-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const path = opfs.trim().replace(/^\/+|\/+$/g, "");
          if (path) props.onSource(path.split("/").pop() as string, { kind: "opfs", path });
        }}
      >
        <label className="grid flex-1 gap-1">
          <span className="text-muted-foreground text-xs">
            Browser storage (OPFS): a folder kept by this browser, nothing to pick
          </span>
          <input
            aria-label="Browser storage folder"
            className={field}
            value={opfs}
            onChange={(e) => setOpfs(e.target.value)}
          />
        </label>
        <Button type="submit" variant="outline" size="sm">
          Open from browser storage
        </Button>
      </form>
      <details className="rounded-md border px-3 py-2">
        <summary className="cursor-pointer text-sm select-none">An S3 bucket</summary>
        <form
          className="mt-2 grid gap-2 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) return;
            props.onSource(s3.prefix.split("/").filter(Boolean).pop() || s3.bucket, {
              kind: "s3",
              ...s3,
            });
          }}
        >
          {(
            [
              ["endpoint", "Endpoint (empty: AWS)"],
              ["region", "Region"],
              ["bucket", "Bucket"],
              ["prefix", "Prefix (a folder in the bucket)"],
              ["accessKeyId", "Access key id"],
              ["secretAccessKey", "Secret access key"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="grid gap-1">
              <span className="text-muted-foreground text-xs">{label}</span>
              <input
                aria-label={label}
                type={key === "secretAccessKey" ? "password" : "text"}
                autoComplete="off"
                className={field}
                value={s3[key]}
                onChange={(e) => setS3((v) => ({ ...v, [key]: e.target.value }))}
              />
            </label>
          ))}
          <p className="text-muted-foreground text-xs sm:col-span-2">
            The bucket must allow CORS from this origin. The keys stay in this tab's studio worker.
          </p>
          <Button type="submit" variant="outline" size="sm" className="sm:col-span-2">
            Open the bucket
          </Button>
        </form>
      </details>
    </div>
  );
}
