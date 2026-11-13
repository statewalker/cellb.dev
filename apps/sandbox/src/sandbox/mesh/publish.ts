// Publishing a sandbox tab in an HTTPeers mesh (its hub: apps/sandbox-hub). The tab becomes a
// mesh member that serves three mounts to the other members, each guarded by `withAccess` with
// the mesh's rules (rules.ts), so what a member may call is the role its invitation gave it:
//
//   /app/…      the running app (viewer and up)     → the preview's site, as the page fetches it
//   /mcp/read   the IDE's tools, read-only (agent)  → createMcpHandler(tools on a read-only capability)
//   /mcp/edit   the IDE's tools (editor)            → createMcpHandler(tools on a read-write one)
//
// The member has no ServiceWorker edge (the page calls nobody; it serves): its platform is
// httpeers' browser node alone. Its identity and the mesh it joined stay in IndexedDB, so a reload
// resumes the membership without a new invitation.

import { type RuleSet, ruleSet } from "@statewalker/httpeers-access";
import { createMounts, type FetchHandler } from "@statewalker/httpeers-core";
import {
  browserPlatform,
  createSession,
  watchPageWake,
} from "@statewalker/httpeers-member/browser";
import { MESH_RULES, SANDBOX_ADVERT } from "./rules";

export interface PublishState {
  phase: string;
  /** This tab's peer id in the mesh, once it has an identity. */
  peerId?: string;
  hubPeerId?: string;
  /** How the tab reaches its hub: "direct" (other members can reach it) or "relay" (they cannot). */
  hubLink?: "direct" | "relay" | null;
  note?: string;
  error?: string;
  controls: { join: boolean; disconnect: boolean; reconnect: boolean; reset: boolean };
}

export interface Publisher {
  /** Resumes a membership, or joins with the `?join=` of `search`. */
  start(search?: string): Promise<void>;
  join(text: string): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  resetIdentity(): Promise<void>;
  state(): PublishState;
  /** Ships a deployable folder (Ship → Build) to the hub, which runs it on CellB at /apps/<name>/. */
  deploy(name: string, files: Map<string, Uint8Array>): Promise<HostedApp>;
  /** What the hub hosts. */
  apps(): Promise<HostedApp[]>;
}

export interface HostedApp {
  name: string;
  release: string;
  deployedAt: number;
  by: string | null;
  files: number;
  bytes: number;
}

/** "My Tasks!" → "my-tasks": the name an app is hosted under. */
export const hostName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63) || "app";

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

let rules: RuleSet | undefined;

export function createPublisher(opts: {
  app: FetchHandler;
  mcpRead: FetchHandler;
  mcpEdit: FetchHandler;
  title: () => string;
  onChange: (s: PublishState) => void;
  /** Relaxes libp2p's dial gater for loopback/private addresses (a hub on this machine, tests). */
  dev?: boolean;
}): Publisher {
  rules ??= ruleSet(MESH_RULES);
  const mounts = createMounts();
  mounts.provide("/app", opts.app);
  mounts.provide("/mcp/read", opts.mcpRead);
  mounts.provide("/mcp/edit", opts.mcpEdit);
  const node = browserPlatform({ dev: opts.dev });
  let current: PublishState = {
    phase: "idle",
    controls: { join: true, disconnect: false, reconnect: false, reset: false },
  };
  let session: ReturnType<typeof createSession> | undefined;
  let handle: { fetch: FetchHandler; hubPeerId: string } | null = null;
  const onHub = async (path: string, init?: RequestInit) => {
    if (!handle) throw new Error("not published: join the mesh first");
    const res = await handle.fetch(
      new Request(`http://local/peers/${handle.hubPeerId}${path}`, init),
    );
    const value = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(value.error ?? `the hub answered ${res.status}`);
    return value;
  };
  const make = (search: string) =>
    createSession({
      key: "peers",
      mounts,
      rules: rules as RuleSet,
      search,
      advertisements: () => [{ id: SANDBOX_ADVERT, kind: "app", title: opts.title() }],
      // A node, no edge: this page serves the mesh and calls nobody through its own fetch().
      platform: { createNode: node.createNode, watchWake: (w) => watchPageWake(w) },
      // The mesh is the one an invitation names, or the one this tab joined before: never a
      // deployment's /httpeers.json.
      readDeploymentConfig: async () => null,
      reload: () => {},
      onChange: (s) => {
        const phase = s.phase as { kind: string; message?: string; peerState?: string };
        handle = phase.kind === "live" ? s.handle : null;
        current = {
          phase: phase.peerState ? `${phase.kind}: ${phase.peerState}` : phase.kind,
          peerId: s.handle?.peerId ?? s.identity ?? undefined,
          hubPeerId: s.handle?.hubPeerId,
          hubLink: s.hubLink,
          note: s.handle?.hubLinkNote,
          error: phase.kind === "failed" || phase.kind === "blocked" ? phase.message : undefined,
          controls: s.controls,
        };
        opts.onChange(current);
      },
    });
  return {
    async start(search = "") {
      session ??= make(search);
      await session.start();
    },
    async join(text) {
      session ??= make("");
      await session.join(text);
    },
    disconnect: async () => session?.disconnect(),
    reconnect: async () => session?.reconnect(),
    resetIdentity: async () => session?.resetIdentity(),
    state: () => current,
    async deploy(name, files) {
      const body: Record<string, string> = {};
      for (const [path, bytes] of files) body[path] = base64(bytes);
      return (await onHub(`/host/apps/${hostName(name)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files: body }),
      })) as unknown as HostedApp;
    },
    apps: async () => (await onHub("/host/apps")) as unknown as HostedApp[],
  };
}

/** The running app, as the mesh sees it: /app/<path> → the preview's site. */
export function appMount(
  fetchApp: (path: string, init: RequestInit) => Promise<Response>,
): FetchHandler {
  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/app\/?/, "") + url.search;
    const init: RequestInit = { method: request.method, headers: request.headers };
    if (request.method !== "GET" && request.method !== "HEAD")
      init.body = await request.arrayBuffer();
    try {
      return await fetchApp(path, init);
    } catch (err) {
      return Response.json({ error: String((err as Error).message ?? err) }, { status: 503 });
    }
  };
}
