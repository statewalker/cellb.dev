// The fragment host on Node (#191; statewalker-root ADR 2026-11-21-fragment-host-and-routing):
// one runtime holding the server halves of many fragments, each a wrangler.jsonc project of its
// own, loaded side by side and reached at `/fragments/{id}/…`.
//
// Each project is loaded with `loadProject` into a namespace of its own: its data directory
// `<data>/fragments/<id>/` (SQLite cells, files, the runtime's own databases), or its own memory.
// So two projects may use the same Worker name, Durable Object classes and binding names without
// sharing a cell, a KV namespace, a D1 database, a queue or a bucket. A single-project host's data
// at the top of `<data>` is never touched.
//
// Projects share the process's realm (fragments are trusted). A project loaded from its sources
// gets its own `cloudflare:workers` scope; a built folder (`cellb build`) reads the process's
// globals instead, so the host refuses it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DurableObjectNamespace } from "../core/namespace.js";
import {
  BUILD_MANIFEST,
  isFilesApi,
  type LoadedProject,
  type ProjectSource,
} from "./built-project.js";
import { type FragmentRoutes, hostOf, linkTo, remoteBase } from "./fragment-routes.js";
import { loadProject, localDir, type NodeLoadProjectOptions } from "./node-load.js";
import {
  isServiceCall,
  type ServicePlacement,
  type ServiceResolver,
  serveServiceCall,
} from "./service-bindings.js";

/**
 * A fragment id: a path segment of lowercase letters, digits, `.`, `_` and `-`, at most 128
 * characters. Lowercase, so no two ids share a data directory on a case-insensitive filesystem.
 */
const FRAGMENT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** The prefix fragments are served under. */
export const FRAGMENTS_PREFIX = "/fragments/";

/** The Durable Object binding taken as a project's fragment DO when it names none. */
export const FRAGMENT_BINDING = "FRAGMENT";

export interface FragmentHostOptions
  extends Omit<NodeLoadProjectOptions, "data" | "bucket" | "services"> {
  /**
   * Where the fragments keep their data: each one under `<data>/fragments/<id>/`. Default:
   * memory, each project its own.
   */
  readonly data?: string;
  /**
   * Where fragments this host does not serve are (#192): a project's service binding to one of
   * them goes there over HTTP. Read at each call, so a function may answer from a table that
   * changes. Default: every fragment is local.
   */
  readonly routes?: FragmentRoutes;
  /** How service calls reach other hosts. */
  readonly remote?: {
    /** Sends a request to another host. Default: `fetch`. */
    readonly fetch?: (request: Request) => Promise<Response>;
    /** The origin of the HTTPeers gateway that serves `/peers/{peerId}/…`, for `peer:` routes. */
    readonly peers?: string;
  };
  /** This host's peer id: `serveLink` answers `/peers/{peerId}/fragments/…` as `/fragments/…`. */
  readonly peerId?: string;
}

export interface AddFragmentOptions {
  /**
   * The Durable Object binding of the project's fragment DO. Default: the binding named
   * `FRAGMENT`, or else the project's only Durable Object binding.
   */
  readonly entry?: string;
}

/** A project the host holds. */
export interface HostedFragment {
  readonly id: string;
  /** The binding of its fragment DO. */
  readonly entry: string;
  /** What its configuration declares that this host does not support, for this project only. */
  readonly unsupported: readonly string[];
  readonly runtime: LoadedProject["runtime"];
}

export interface FragmentHost {
  /**
   * Load a project's sources as the fragment `id`, while the host runs. Rejects, with nothing
   * added, for an id in use or not a path segment, a built folder, or a project without a
   * fragment DO binding.
   */
  add(id: string, source: ProjectSource, options?: AddFragmentOptions): Promise<HostedFragment>;
  /** Stop a fragment's objects and drop it from the host; its data is kept. */
  remove(id: string): Promise<void>;
  /**
   * Stop a fragment's objects and keep it as disabled (statewalker-root#259): its requests answer
   * 503 without waking its DO, and bindings to it are unavailable. Its data is kept.
   */
  disable(id: string): Promise<void>;
  /** Load a disabled fragment again, from the source and options it was added with. */
  enable(id: string): Promise<HostedFragment>;
  /** Its state, or undefined for a fragment the host does not have. */
  state(id: string): "enabled" | "disabled" | undefined;
  /** The fragments the host has, enabled or disabled, in the order they were added. */
  ids(): string[];
  project(id: string): HostedFragment | undefined;
  /**
   * `/fragments/{id}/{path}` (or `/peers/{peerId}/fragments/{id}/{path}` with this host's own
   * `peerId`): to the fragment DO of `id` at `idFromName(id)`, with the path `/{path}` (the prefix
   * stripped). 503 for a disabled fragment. 404 for a fragment the host does not hold, and for any
   * other path.
   */
  fetch(request: Request): Promise<Response>;
  /**
   * What another host's service bindings call (#192): `fetch`, plus the calls to the fragments'
   * entrypoints that service bindings send. Mount it only behind an authenticated link (HTTPeers
   * checks the peer's capability): it runs the methods of every fragment's entrypoints.
   */
  serveLink(request: Request): Promise<Response>;
  /** Remove every fragment. */
  close(): Promise<void>;
}

/**
 * Whether a source is a built folder (`cellb build`), which reads the process's globals. A local
 * folder (a path, or a `file:` URL as a string or a URL) is read as `loadProject` reads it; any
 * other URL is a built folder on Node.
 */
async function isBuilt(source: ProjectSource): Promise<boolean> {
  if (isFilesApi(source)) return (await source.stats?.(`/${BUILD_MANIFEST}`)) !== undefined;
  const dir = localDir(source);
  return dir === undefined || existsSync(join(dir, BUILD_MANIFEST));
}

const notFound = (message: string) =>
  new Response(message, { status: 404, headers: { "content-type": "text/plain" } });

const unavailable = (reason: string): ServicePlacement => ({ kind: "unavailable", reason });

/** `/fragments/{id}/{path}` → the id and `/{path}`; undefined for any other path. */
function fragmentPath(pathname: string): { id: string; path: string } | undefined {
  if (!pathname.startsWith(FRAGMENTS_PREFIX)) return undefined;
  const rest = pathname.slice(FRAGMENTS_PREFIX.length);
  const slash = rest.indexOf("/");
  try {
    const id = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
    return { id, path: slash < 0 ? "/" : rest.slice(slash) };
  } catch {
    return undefined;
  }
}

export function createFragmentHost(options: FragmentHostOptions = {}): FragmentHost {
  const { data, routes, remote, peerId, ...loadOptions } = options;

  /** Where the service bindings of the fragment `caller` find `service`, at each call. */
  const servicesOf =
    (caller: string): ServiceResolver =>
    (service) => {
      if (closed || !loaded.has(caller))
        return unavailable(`the calling fragment "${caller}" is not active`);
      const host = hostOf(routes, service);
      if (host === "local") {
        const held = loaded.get(service);
        return held
          ? { kind: "runtime", runtime: held.project.runtime }
          : unavailable(`no fragment "${service}" is active on this host`);
      }
      const base = remoteBase(host, service, remote?.peers);
      if (!base)
        return unavailable(
          `fragment "${service}" is at ${host}, and this host has no way there (remote.peers)`,
        );
      return { kind: "link", send: linkTo(base, remote?.fetch ?? ((r) => fetch(r))) };
    };
  const loaded = new Map<string, { fragment: HostedFragment; project: LoadedProject }>();
  // Adds in flight, by id: a remove or a close during one cancels it (it closes its project).
  const adding = new Map<string, { cancelled?: string; done: Promise<unknown> }>();
  // Every fragment the host has, in the order added: its state and what it was added from.
  const known = new Map<
    string,
    { state: "enabled" | "disabled"; source: ProjectSource; options: AddFragmentOptions }
  >();
  let closed = false;

  async function add(
    id: string,
    source: ProjectSource,
    options: AddFragmentOptions = {},
  ): Promise<HostedFragment> {
    if (closed) throw new Error("the fragment host is closed");
    if (!FRAGMENT_ID.test(id))
      throw new Error(`"${id}" is not a fragment id: lowercase letters, digits, ".", "_", "-"`);
    if (loaded.has(id) || adding.has(id) || known.has(id))
      throw new Error(`"${id}" is already on this host`);
    const fragment = await start(id, source, options);
    known.set(id, { state: "enabled", source, options });
    return fragment;
  }

  async function start(
    id: string,
    source: ProjectSource,
    { entry }: AddFragmentOptions,
  ): Promise<HostedFragment> {
    if (adding.has(id)) throw new Error(`"${id}" is already being added`);
    const pending: { cancelled?: string; done: Promise<unknown> } = { done: Promise.resolve() };
    adding.set(id, pending);
    const work = load(id, source, entry, pending);
    pending.done = work.catch(() => {});
    try {
      return await work;
    } finally {
      adding.delete(id);
    }
  }

  async function load(
    id: string,
    source: ProjectSource,
    entry: string | undefined,
    pending: { cancelled?: string },
  ): Promise<HostedFragment> {
    if (await isBuilt(source))
      throw new Error(
        `"${id}": a built folder reads the process's globals (one per process); load its source folder`,
      );
    const project = await loadProject(source, {
      ...loadOptions,
      services: servicesOf(id),
      ...(data !== undefined ? { data: join(data, "fragments", id) } : {}),
    });
    // The project's own bindings, as its configuration declares them: not the runtime's hidden
    // ones (KV, D1, queues and workflows are Durable Objects inside it).
    const names = (project.config.durable_objects?.bindings ?? []).map((b) => b.name);
    const chosen =
      entry ??
      (names.includes(FRAGMENT_BINDING)
        ? FRAGMENT_BINDING
        : names.length === 1
          ? names[0]
          : undefined);
    if (!chosen || !names.includes(chosen)) {
      await project.close();
      throw new Error(
        entry
          ? `"${id}": no Durable Object binding "${entry}"`
          : `"${id}": no fragment DO: name its binding ${FRAGMENT_BINDING}, or pass { entry }`,
      );
    }
    if (pending.cancelled) {
      await project.close();
      throw new Error(`"${id}" was ${pending.cancelled} while it was being added`);
    }
    const fragment: HostedFragment = Object.freeze({
      id,
      entry: chosen,
      unsupported: Object.freeze([...project.unsupported]),
      runtime: project.runtime,
    });
    loaded.set(id, { fragment, project });
    return fragment;
  }

  async function remove(id: string, why = "removed"): Promise<void> {
    known.delete(id);
    await stop(id, why);
  }

  async function disable(id: string): Promise<void> {
    const entry = known.get(id);
    if (!entry) throw new Error(`"${id}" is not on this host`);
    if (entry.state === "disabled") return;
    // Unrouted first (503), then stopped.
    entry.state = "disabled";
    await stop(id, "disabled");
  }

  async function enable(id: string): Promise<HostedFragment> {
    const entry = known.get(id);
    if (!entry) throw new Error(`"${id}" is not on this host`);
    const held = loaded.get(id);
    if (entry.state === "enabled" && held) return held.fragment;
    if (closed) throw new Error("the fragment host is closed");
    const fragment = await start(id, entry.source, entry.options);
    // Removed while it loaded: it does not stay running.
    if (known.get(id) !== entry) {
      await stop(id, "removed");
      throw new Error(`"${id}" was removed while it was being enabled`);
    }
    entry.state = "enabled";
    return fragment;
  }

  async function stop(id: string, why: string): Promise<void> {
    const pending = adding.get(id);
    if (pending) {
      pending.cancelled = why;
      await pending.done;
    }
    const held = loaded.get(id);
    if (!held) return;
    // Unrouted first, so no new request reaches it while it stops.
    loaded.delete(id);
    await held.project.close();
  }

  async function fetchFragment(request: Request, pathname: string): Promise<Response> {
    if (!pathname.startsWith(FRAGMENTS_PREFIX) && pathname !== "/fragments")
      return notFound("not a fragment path");
    const target = fragmentPath(pathname);
    if (!target) return notFound("not a fragment id");
    const held = loaded.get(target.id);
    if (!held)
      return known.get(target.id)?.state === "disabled"
        ? new Response(`fragment "${target.id}" is disabled`, {
            status: 503,
            headers: { "content-type": "text/plain" },
          })
        : notFound(`no fragment "${target.id}" on this host`);
    const url = new URL(request.url);
    const forwarded = new URL(target.path, url);
    forwarded.search = url.search;
    const ns = held.project.runtime.env[held.fragment.entry] as DurableObjectNamespace;
    return ns.get(ns.idFromName(target.id)).fetch(new Request(forwarded, request));
  }

  /** The request's path, `/peers/{peerId}/` taken off when it names this host's own peer id. */
  const ownPath = (request: Request): string => {
    const { pathname } = new URL(request.url);
    const self = peerId !== undefined ? `/peers/${encodeURIComponent(peerId)}/` : undefined;
    return self && pathname.startsWith(self) ? pathname.slice(self.length - 1) : pathname;
  };

  return {
    add,
    remove,
    disable,
    enable,
    state: (id) => known.get(id)?.state,
    ids: () => [...known.keys()],
    project: (id) => loaded.get(id)?.fragment,
    fetch: (request) => fetchFragment(request, ownPath(request)),
    async serveLink(request) {
      const pathname = ownPath(request);
      if (!isServiceCall(request)) return fetchFragment(request, pathname);
      const target = fragmentPath(pathname);
      return serveServiceCall(
        request,
        target && loaded.get(target.id)?.project.runtime,
        `no fragment "${target?.id ?? ""}" is active on this host`,
      );
    },
    async close() {
      closed = true;
      for (const id of [...adding.keys(), ...loaded.keys()]) await stop(id, "closed");
      known.clear();
    },
  };
}
