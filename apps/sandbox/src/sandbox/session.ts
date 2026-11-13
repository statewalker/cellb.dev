// The page's side of a project: the studio worker owns the files, the page holds capabilities.
//
//   connectStudio(worker)        the studio's HTTP over a MessagePort (and its own messages)
//   openProjectSession(...)      mounts a source (sources.ts) as a workspace, then mints:
//                                  owner  a token with every right ("yolo" on "/"): the page's
//                                         edits, as a FilesApi (CapFilesApi over TokenCap)
//                                  build  a read-only token: what the runner builds from
//                                  more   tokenFor(mode): the agents', other agents' tools
//   readProject(session)         the tree as the owner token sees it (node_modules & co. left out)
//
// The page is the workspace's admin (it owns the project): it alone mints session tokens. In
// a browser the studio has no network ingress, so its admin key is not a secret here.

import { linkOverPort } from "@statewalker/cellb";
import type { FilesApi } from "@statewalker/webrun-files";
import type { TreeEntry } from "../../studio/src/capfs/authority";
import { files, type StudioSend, TokenCap } from "../../studio/src/capfs/token-cap";
import { decodeWire } from "../../studio/src/capfs/wire";
import { type ProjectFiles, SKIPPED_DIRS } from "./project";
import type { SourceSpec } from "./sources";
import type { FromStudio, ToStudio } from "./studio-protocol";

export const STUDIO_ADMIN_KEY = "sandbox-page";

export type AgentMode = "yolo" | "plan" | "readonly";

export interface StudioConnection {
  send: StudioSend;
  /** A JSON request to the studio; admin requests carry the admin key. */
  request<T = unknown>(
    path: string,
    init?: { method?: string; body?: unknown; headers?: Record<string, string>; admin?: boolean },
  ): Promise<{ status: number; value?: T; error?: string }>;
  mount(ws: string, source: SourceSpec): Promise<void>;
  unmount(ws: string): void;
  /** A port the runner builds through (served by the studio worker). */
  portForRunner(): MessagePort;
}

export function connectStudio(
  worker: Worker,
  studioUrl: string,
  onMessage: (m: FromStudio) => void,
): StudioConnection {
  const post = (m: ToStudio, transfer: Transferable[] = []) => worker.postMessage(m, transfer);
  const mounts = new Map<number, (error?: string) => void>();
  let mountId = 0;
  worker.addEventListener("message", (e: MessageEvent<FromStudio>) => {
    const m = e.data;
    if (!m || typeof m !== "object" || !("type" in m)) return;
    if (m.type === "mounted") {
      mounts.get(m.id)?.(m.error);
      mounts.delete(m.id);
    } else onMessage(m);
  });
  post({ type: "init", studioUrl });
  const channel = new MessageChannel();
  post({ type: "connect", port: channel.port2 }, [channel.port2]);
  const link = linkOverPort(channel.port1);
  const send: StudioSend = async (req) => (await link).send(req);
  return {
    send,
    async request(path, init = {}) {
      const res = await send(
        new Request(`http://studio${path}`, {
          method: init.method ?? (init.body === undefined ? "GET" : "POST"),
          headers: {
            "content-type": "application/json",
            ...(init.admin ? { authorization: `Bearer ${STUDIO_ADMIN_KEY}` } : {}),
            ...init.headers,
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        }),
      );
      let data: { value?: unknown; error?: string };
      try {
        data = (await res.json()) as typeof data;
      } catch {
        data = { error: `HTTP ${res.status}` };
      }
      return { status: res.status, value: decodeWire(data.value) as never, error: data.error };
    },
    mount(ws, source) {
      const id = ++mountId;
      return new Promise((resolve, reject) => {
        mounts.set(id, (error) => (error ? reject(new Error(error)) : resolve()));
        post({ type: "mount", id, ws, source });
      });
    },
    unmount(ws) {
      post({ type: "unmount", ws });
    },
    portForRunner() {
      const ch = new MessageChannel();
      post({ type: "connect", port: ch.port2, scope: "fs" }, [ch.port2]);
      return ch.port1;
    },
  };
}

export interface ProjectSession {
  ws: string;
  source: SourceSpec;
  /** The owner capability (every right), as a token and as a FilesApi. */
  owner: TokenCap;
  fs: FilesApi;
  /** A read-only token: what the runner builds and runs from. */
  buildToken: string;
  /** A token for this mode (cached): the agents' and other agents' capabilities. */
  tokenFor(mode: AgentMode, opts?: { model?: boolean }): Promise<string>;
  /** The model budget of the session behind tokenFor(mode, { model: true }); null: unlimited. */
  setBudget(
    mode: AgentMode,
    budget: { turns: number | null; tokens: number | null },
  ): Promise<void>;
}

const slug = (name: string) =>
  name
    .replace(/[^a-z0-9-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 40) || "project";

export async function openProjectSession(
  studio: StudioConnection,
  name: string,
  source: SourceSpec,
): Promise<ProjectSession> {
  // One workspace per opening: its sessions and conversations belong to this project.
  const ws = `${slug(name)}-${crypto.randomUUID().slice(0, 8)}`;
  await studio.mount(ws, source);
  const sessions = new Map<string, Promise<{ session: string; token: string }>>();
  const sessionFor = (mode: AgentMode, opts: { model?: boolean } = {}) => {
    const key = `${mode}:${opts.model ? 1 : 0}`;
    let t = sessions.get(key);
    if (!t) {
      t = studio
        .request<{ session: string; token: string }>(`/api/w/${ws}/sessions`, {
          admin: true,
          body: { user: "owner", rights: ["/"], mode, model: !!opts.model },
        })
        .then((r) => {
          if (r.status >= 400 || !r.value) throw new Error(`session: ${r.error ?? r.status}`);
          return r.value;
        });
      t.catch(() => sessions.delete(key));
      sessions.set(key, t);
    }
    return t;
  };
  const tokenFor = async (mode: AgentMode, opts: { model?: boolean } = {}) =>
    (await sessionFor(mode, opts)).token;
  const setBudget = async (
    mode: AgentMode,
    budget: { turns: number | null; tokens: number | null },
  ) => {
    const { session } = await sessionFor(mode, { model: true });
    const r = await studio.request(`/api/w/${ws}/sessions/${session}/model`, {
      admin: true,
      body: budget,
    });
    if (r.status >= 400) throw new Error(`budget: ${r.error ?? r.status}`);
  };
  const owner = new TokenCap(studio.send, ws, await tokenFor("yolo"));
  return {
    ws,
    source,
    owner,
    fs: files(owner),
    buildToken: await tokenFor("readonly"),
    tokenFor,
    setBudget,
  };
}

/** The project as the owner token sees it: files (with contents), empty folders, a signature. */
export async function readProject(
  s: ProjectSession,
): Promise<{ files: ProjectFiles; dirs: Set<string>; signature: string }> {
  const tree = await s.owner.readTree("/", { contents: true, dirs: true, skip: [...SKIPPED_DIRS] });
  const files: ProjectFiles = new Map();
  const dirs = new Set<string>();
  for (const e of tree) {
    if (e.dir) dirs.add(e.path);
    else if (e.path.split("/").pop() !== ".DS_Store") files.set(e.path, e.data ?? new Uint8Array());
  }
  // Folders with files below them are implied by the files.
  for (const d of [...dirs])
    if ([...files.keys()].some((p) => p.startsWith(`${d}/`))) dirs.delete(d);
  return { files, dirs, signature: signatureOf(tree) };
}

/** Sizes and dates only: cheap enough to poll for changes (agents', the disk's, others'). */
export async function projectSignature(s: ProjectSession): Promise<string> {
  return signatureOf(await s.owner.readTree("/", { dirs: true, skip: [...SKIPPED_DIRS] }));
}

const signatureOf = (tree: TreeEntry[]) =>
  tree
    .map((e) => `${e.path}:${e.dir ? "d" : `${e.size}:${e.mtime}`}`)
    .sort()
    .join("\n");
