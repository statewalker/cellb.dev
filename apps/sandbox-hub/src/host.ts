// The hub as a host: the deployable folders sandbox tabs ship to it, run on CellB in this Node
// process and served to the mesh's members. The same folder runs on Cloudflare (wrangler deploy),
// celld and CellB anywhere: here it is CellB, and the mesh is the network.
//
//   PUT    /host/apps/<name>   { files: { "/worker.js": base64, … } }  deploy (publisher, admin)
//   DELETE /host/apps/<name>                                          take down (publisher, admin)
//   GET    /host/apps                                                 what is hosted (viewer and up)
//   *      /apps/<name>/…                                             the app itself (viewer and up)
//
// Each deploy is a new release folder; the app's Durable Objects keep their data across releases
// (<dir>/<name>/data). A release that does not load leaves the previous one serving.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { FetchHandler } from "@statewalker/httpeers-core";
import { lookupPeer } from "@statewalker/httpeers-core";

interface Loaded {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}
export interface HostedApp {
  name: string;
  release: string;
  deployedAt: number;
  by: string | null;
  files: number;
  bytes: number;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_BYTES = 64 * 1024 * 1024;
const KEEP_RELEASES = 3;

export function createAppHost(opts: {
  dir: string;
  log?: (line: string) => void;
  /** Loads a deployable folder (default: @statewalker/cellb/node's loadProject). */
  load?: (dir: string, data: string) => Promise<Loaded>;
}) {
  const log = opts.log ?? ((l: string) => console.log(l));
  const load =
    opts.load ??
    (async (dir: string, data: string) => {
      const { loadProject } = await import("@statewalker/cellb/node");
      return loadProject(dir, { data });
    });
  const apps = new Map<string, { meta: HostedApp; project: Loaded }>();
  let queue = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => {
    const next = queue.then(fn, fn);
    queue = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  async function start(name: string, meta: HostedApp) {
    const project = await load(join(opts.dir, name, meta.release), join(opts.dir, name, "data"));
    const before = apps.get(name);
    apps.set(name, { meta, project });
    await before?.project.close().catch(() => {});
  }

  async function restore() {
    await mkdir(opts.dir, { recursive: true });
    for (const name of await readdir(opts.dir)) {
      try {
        const meta = JSON.parse(
          await readFile(join(opts.dir, name, "app.json"), "utf8"),
        ) as HostedApp;
        await start(name, meta);
        log(`host: ${name} (${meta.release}) serving`);
      } catch (err) {
        log(`host: ${name} not restored: ${(err as Error).message}`);
      }
    }
  }

  async function deploy(name: string, files: Record<string, string>, by: string | null) {
    if (!NAME.test(name))
      throw new HttpError(400, "a name is lowercase letters, digits and dashes");
    const entries = Object.entries(files);
    if (!entries.some(([p]) => p === "/wrangler.json" || p === "/wrangler.jsonc"))
      throw new HttpError(
        400,
        "not a deployable folder: no wrangler.json (Ship → Build makes one)",
      );
    const release = `r${Date.now().toString(36)}`;
    const root = join(opts.dir, name, release);
    let bytes = 0;
    for (const [path, b64] of entries) {
      const rel = normalize(path).replace(/^\/+/, "");
      if (!rel || rel.startsWith("..")) throw new HttpError(400, `bad path ${path}`);
      const data = Buffer.from(b64, "base64");
      bytes += data.length;
      if (bytes > MAX_BYTES) throw new HttpError(413, `more than ${MAX_BYTES} bytes`);
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), data);
    }
    const meta: HostedApp = {
      name,
      release,
      deployedAt: Date.now(),
      by,
      files: entries.length,
      bytes,
    };
    try {
      await start(name, meta);
    } catch (err) {
      await rm(root, { recursive: true, force: true });
      throw new HttpError(422, `the release did not load: ${(err as Error).message}`);
    }
    await writeFile(join(opts.dir, name, "app.json"), `${JSON.stringify(meta, null, 2)}\n`);
    // Older releases go, the last few stay (a manual rollback is editing app.json).
    const releases = (await readdir(join(opts.dir, name)))
      .filter((d) => /^r[0-9a-z]+$/.test(d))
      .sort();
    for (const old of releases.slice(0, Math.max(0, releases.length - KEEP_RELEASES)))
      await rm(join(opts.dir, name, old), { recursive: true, force: true });
    log(`host: ${name} deployed (${release}, ${entries.length} files${by ? `, by ${by}` : ""})`);
    return meta;
  }

  async function remove(name: string) {
    const app = apps.get(name);
    if (!app) return false;
    apps.delete(name);
    await app.project.close().catch(() => {});
    await rm(join(opts.dir, name), { recursive: true, force: true });
    log(`host: ${name} taken down`);
    return true;
  }

  const hostApi: FetchHandler = async (request) => {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/host\/apps(?:\/([^/]+))?\/?$/);
    try {
      if (!m) throw new HttpError(404, "not found");
      if (!m[1] && request.method === "GET")
        return Response.json([...apps.values()].map((a) => a.meta));
      if (m[1] && request.method === "PUT") {
        const body = (await request.json()) as { files?: Record<string, string> };
        if (!body.files) throw new HttpError(400, "expected { files: { path: base64 } }");
        const peer = lookupPeer(request);
        const by = typeof peer === "string" ? peer : null;
        return Response.json(
          await serial(() => deploy(m[1], body.files as Record<string, string>, by)),
        );
      }
      if (m[1] && request.method === "DELETE")
        return (await serial(() => remove(m[1])))
          ? Response.json({ removed: m[1] })
          : Response.json({ error: "no such app" }, { status: 404 });
      throw new HttpError(405, "method not allowed");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return Response.json({ error: (err as Error).message }, { status });
    }
  };

  const appsMount: FetchHandler = async (request) => {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/apps\/([^/]+)(\/.*)?$/);
    if (!m) return Response.json([...apps.keys()]);
    const app = apps.get(m[1]);
    if (!app) return Response.json({ error: `no app ${m[1]}` }, { status: 404 });
    if (!m[2]) return new Response(null, { status: 302, headers: { location: `${m[1]}/` } });
    // The app sees its own URL space, as on any host.
    const init: RequestInit = { method: request.method, headers: request.headers };
    if (request.method !== "GET" && request.method !== "HEAD")
      init.body = await request.arrayBuffer();
    try {
      return await app.project.fetch(new Request(`http://${m[1]}.app${m[2]}${url.search}`, init));
    } catch (err) {
      return Response.json({ error: String((err as Error).message ?? err) }, { status: 502 });
    }
  };

  return {
    restore,
    deploy: (name: string, files: Record<string, string>, by: string | null = null) =>
      serial(() => deploy(name, files, by)),
    remove: (name: string) => serial(() => remove(name)),
    list: () => [...apps.values()].map((a) => a.meta),
    mounts: { "/host": hostApi, "/apps": appsMount } as Record<string, FetchHandler>,
    async close() {
      for (const a of apps.values()) await a.project.close().catch(() => {});
      apps.clear();
    },
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
