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
import { loadProject, localDir, type NodeLoadProjectOptions } from "./node-load.js";

/**
 * A fragment id: a path segment of lowercase letters, digits, `.`, `_` and `-`, at most 128
 * characters. Lowercase, so no two ids share a data directory on a case-insensitive filesystem.
 */
const FRAGMENT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** The prefix fragments are served under. */
export const FRAGMENTS_PREFIX = "/fragments/";

/** The Durable Object binding taken as a project's fragment DO when it names none. */
export const FRAGMENT_BINDING = "FRAGMENT";

export interface FragmentHostOptions extends Omit<NodeLoadProjectOptions, "data" | "bucket"> {
  /**
   * Where the fragments keep their data: each one under `<data>/fragments/<id>/`. Default:
   * memory, each project its own.
   */
  readonly data?: string;
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
  /** The fragments held, in the order they were added. */
  ids(): string[];
  project(id: string): HostedFragment | undefined;
  /**
   * `/fragments/{id}/{path}`: to the fragment DO of `id` at `idFromName(id)`, with the path
   * `/{path}` (the prefix stripped). 404 for a fragment the host does not hold, and for any
   * other path.
   */
  fetch(request: Request): Promise<Response>;
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

export function createFragmentHost(options: FragmentHostOptions = {}): FragmentHost {
  const { data, ...loadOptions } = options;
  const loaded = new Map<string, { fragment: HostedFragment; project: LoadedProject }>();
  // Adds in flight, by id: a remove or a close during one cancels it (it closes its project).
  const adding = new Map<string, { cancelled?: string; done: Promise<unknown> }>();
  let closed = false;

  async function add(
    id: string,
    source: ProjectSource,
    { entry }: AddFragmentOptions = {},
  ): Promise<HostedFragment> {
    if (closed) throw new Error("the fragment host is closed");
    if (!FRAGMENT_ID.test(id))
      throw new Error(`"${id}" is not a fragment id: lowercase letters, digits, ".", "_", "-"`);
    if (loaded.has(id) || adding.has(id)) throw new Error(`"${id}" is already on this host`);
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
      ...(data !== undefined ? { data: join(data, "fragments", id) } : {}),
    });
    const bindings = project.runtime.durableObjectBindings;
    const names = Object.keys(bindings);
    const chosen =
      entry ??
      (FRAGMENT_BINDING in bindings ? FRAGMENT_BINDING : names.length === 1 ? names[0] : undefined);
    if (!chosen || !(chosen in bindings)) {
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

  return {
    add,
    remove,
    ids: () => [...loaded.keys()],
    project: (id) => loaded.get(id)?.fragment,
    async fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(FRAGMENTS_PREFIX) && url.pathname !== "/fragments")
        return notFound("not a fragment path");
      const rest = url.pathname.slice(FRAGMENTS_PREFIX.length);
      const slash = rest.indexOf("/");
      let id: string;
      try {
        id = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
      } catch {
        return notFound("not a fragment id");
      }
      const held = loaded.get(id);
      if (!held) return notFound(`no fragment "${id}" on this host`);
      const forwarded = new URL(slash < 0 ? "/" : rest.slice(slash), url);
      forwarded.search = url.search;
      const ns = held.project.runtime.env[held.fragment.entry] as DurableObjectNamespace;
      return ns.get(ns.idFromName(id)).fetch(new Request(forwarded, request));
    },
    async close() {
      closed = true;
      for (const id of [...adding.keys(), ...loaded.keys()]) await remove(id, "closed");
    },
  };
}
