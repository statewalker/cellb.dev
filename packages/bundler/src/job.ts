/**
 * App 3, the bundler: a project turned into one package, for download or to run as a wrangler
 * project (or a Worker Loader payload) on any host. One `BuildJob` object per build; the build id
 * is the hash of the inputs and the spec, so the same build is never made twice.
 *
 *   POST /builds[?tier=object|runner][&entry=…][&minify=1]   body: a ZIP or JSON { files, spec }
 *   POST /builds?project=<id>&snapshot=<snap>                the snapshot of a project (App 2)
 *        (header x-build-spec: a JSON BuildSpec; `kind=astro`, or an astro.config.* in the
 *        project, builds an Astro project from its sources first: src/astro)
 *        → { id, status, tier, … }  (an in-object build answers when it is done)
 *   GET  /builds/<id>                     status, log, stats, output links
 *   GET  /b/<id>/<path>                   an output file: wrangler.json, worker.js, worker.js.map, assets/…
 *   GET  /b/<id>/project.zip              the whole output: unzip and run `wrangler dev`, `celld dev`, cellb
 *   GET  /b/<id>/loader.json              a Worker Loader payload
 *
 * Placement: a build whose inputs exceed IN_OBJECT_BUILD_MAX_BYTES (default 8 MB), or one asked
 * with `tier=runner`, is not run in the object (a Workers isolate has 128 MB): it waits for a Node
 * runner (`bin/webrun-build.mjs --runner <origin>`), which claims it, builds it with the same
 * `buildProject`, and uploads the output.
 *
 *   POST /builds/claim                    runner: the next queued build, or 204
 *   GET  /builds/<id>/input.zip           runner: the inputs
 *   PUT  /builds/<id>/output              runner: the output ZIP (header x-build-stats: JSON)
 *   POST /builds/<id>/fail                runner: the build failed (body: the error)
 */
import { DurableObject } from "cloudflare:workers";
import { astroCompilerFromRegistry } from "@statewalker/cellb-astro-builder/compiler";
import {
  astroInLoader,
  canEvaluate,
  type WorkerLoader,
} from "@statewalker/cellb-astro-builder/loader";
import type { PlatformEnv } from "@statewalker/cellb-platform-core/env";
import { registryFetch } from "@statewalker/cellb-platform-core/registry";
import { SqlFilesApi } from "@statewalker/cellb-platform-core/sql-files";
import {
  json,
  mimeOf,
  readUpload,
  sha256Hex,
  text,
  unzip,
  zip,
  zipStream,
} from "@statewalker/cellb-platform-core/util";
import { getEsbuild } from "@statewalker/cellb-platform-core/wasm";
import { readFile } from "@statewalker/webrun-files";
import { buildAny } from "./any.js";
import { BUILDER_VERSION, type BuildSpec, defaultPackages } from "./build.js";

const QUEUE = "_queue";

function stubOf(ns: DurableObjectNamespace, name: string) {
  return ns.getByName ? ns.getByName(name) : ns.get(ns.idFromName(name));
}

function specFrom(url: URL, body?: BuildSpec): BuildSpec {
  const q = url.searchParams;
  const spec: BuildSpec = { ...body };
  if (q.get("entry")) spec.entry = q.get("entry") ?? undefined;
  if (q.get("kind")) spec.kind = q.get("kind") as BuildSpec["kind"];
  if (q.has("minify")) spec.minify = q.get("minify") !== "0";
  if (q.has("sourcemap")) spec.sourcemap = q.get("sourcemap") !== "0";
  if (q.has("lowerAwait")) spec.lowerAwait = q.get("lowerAwait") !== "0";
  return spec;
}

/** Routes `/builds` and `/b/<id>/…`. */
export async function handleBuilds(request: Request, env: PlatformEnv): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "b") {
    if (!parts[1]) return text("build id expected\n", 400);
    return stubOf(env.BUILDS, parts[1]).fetch(request);
  }
  // /builds
  if (parts.length === 1 && request.method === "POST") {
    let files: Map<string, Uint8Array>;
    let bodySpec: BuildSpec | undefined;
    let original: Uint8Array | undefined;
    const project = url.searchParams.get("project");
    if (project) {
      const snap = url.searchParams.get("snapshot") ?? "live";
      const res = await stubOf(env.PROJECTS, project).fetch(
        `${url.origin}/p/${project}/export/${snap}`,
      );
      if (!res.ok) return text(`project ${project}: ${res.status} ${await res.text()}\n`, 400);
      files = await unzip(new Uint8Array(await res.arrayBuffer()));
    } else if ((request.headers.get("content-type") ?? "").includes("json")) {
      const body = (await request.clone().json()) as { spec?: BuildSpec };
      bodySpec = body.spec;
      files = await readUpload(request);
    } else {
      // A ZIP body travels on as it came: no second copy of a large upload in this isolate.
      original = new Uint8Array(await request.arrayBuffer());
      files = await unzip(original);
    }
    // A ZIP upload carries its spec (an Astro build's `astro` options, say) in a header.
    const headerSpec = request.headers.get("x-build-spec");
    let parsedSpec: BuildSpec = {};
    try {
      parsedSpec = headerSpec ? (JSON.parse(headerSpec) as BuildSpec) : {};
    } catch {
      return text("x-build-spec: not JSON\n", 400);
    }
    const spec = specFrom(url, { ...parsedSpec, ...bodySpec });
    const tier = url.searchParams.get("tier") ?? "auto";
    const sorted = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const hashes: string[] = [];
    for (const [p, b] of sorted) hashes.push(`${p}\0${await sha256Hex(b)}`);
    const id = (
      await sha256Hex(`${BUILDER_VERSION}\n${hashes.join("\n")}\n${JSON.stringify(spec)}`)
    ).slice(0, 20);
    const input = original ?? zip(sorted);
    files.clear();
    return stubOf(env.BUILDS, id).fetch(
      new Request(`${url.origin}/builds/${id}/create?tier=${tier}`, {
        method: "POST",
        headers: { "x-build-spec": JSON.stringify(spec) },
        body: input as BodyInit,
      }),
    );
  }
  if (parts[1] === "claim" && request.method === "POST")
    return stubOf(env.BUILDS, QUEUE).fetch(request);
  // From outside, only these: status, and the runner's input, output and failure. The object's
  // own actions (create, enqueue, dequeue) are sent by this file, never routed from a request.
  const action = parts[2] ?? "";
  const external =
    parts.length <= 3 &&
    /^[0-9a-f]{20}$/.test(parts[1] ?? "") &&
    ((action === "" && request.method === "GET") ||
      (action === "input.zip" && request.method === "GET") ||
      (action === "output" && request.method === "PUT") ||
      (action === "fail" && request.method === "POST"));
  if (external) return stubOf(env.BUILDS, parts[1]).fetch(request);
  if (parts[1]) return text("not found\n", 404);
  return text("POST /builds with a ZIP or JSON { files }, or ?project=<id>&snapshot=<snap>\n", 400);
}

type Status = "new" | "receiving" | "queued" | "running" | "done" | "failed";

/** A job "running" or "receiving" longer than this was cut off (eviction, limits): build it again. */
const STALE_MS = 15 * 60_000;

export class BuildJob extends DurableObject<PlatformEnv> {
  input: SqlFilesApi;
  output: SqlFilesApi;

  constructor(ctx: DurableObjectState, env: PlatformEnv) {
    super(ctx, env);
    this.input = new SqlFilesApi(ctx.storage.sql, "bin");
    this.output = new SqlFilesApi(ctx.storage.sql, "bout");
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS job (k TEXT PRIMARY KEY, v TEXT)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS job_log (n INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, line TEXT)",
    );
    sql.exec("CREATE TABLE IF NOT EXISTS queue (id TEXT PRIMARY KEY, at INTEGER, claimed INTEGER)");
  }

  #get(k: string) {
    return this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM job WHERE k = ?", k).toArray()[0]
      ?.v;
  }
  #set(k: string, v: string) {
    this.ctx.storage.sql.exec(
      "INSERT INTO job (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      k,
      v,
    );
  }
  #log(line: string) {
    this.ctx.storage.sql.exec("INSERT INTO job_log (at, line) VALUES (?, ?)", Date.now(), line);
  }

  #status(id: string, origin: string) {
    const status = (this.#get("status") ?? "new") as Status;
    const out = status === "done" ? this.output.filePaths("/") : [];
    return {
      id,
      status,
      tier: this.#get("tier"),
      spec: JSON.parse(this.#get("spec") ?? "{}"),
      stats: (() => {
        try {
          return JSON.parse(this.#get("stats") ?? "null");
        } catch {
          return null;
        }
      })(),
      error: this.#get("error") || undefined,
      log: this.ctx.storage.sql
        .exec<{ line: string }>("SELECT line FROM job_log ORDER BY n")
        .toArray()
        .map((r) => r.line),
      outputs:
        status === "done"
          ? {
              folder: `${origin}/b/${id}/`,
              zip: `${origin}/b/${id}/project.zip`,
              loader: `${origin}/b/${id}/loader.json`,
              files: out.map((p) => `${origin}/b/${id}${p}`),
            }
          : undefined,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    // The queue object.
    if (parts[0] === "builds" && parts[1] === "claim") return this.#claim(url.origin);
    if (parts[0] === "builds" && parts[2] === "dequeue") {
      this.ctx.storage.sql.exec("DELETE FROM queue WHERE id = ?", parts[1]);
      return new Response(null, { status: 204 });
    }
    if (parts[0] === "builds" && parts[2] === "enqueue") {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO queue (id, at, claimed) VALUES (?, ?, 0)",
        parts[1],
        Date.now(),
      );
      return new Response(null, { status: 204 });
    }

    const id = parts[1];
    if (parts[0] === "b")
      try {
        return this.#serveOutput(id, parts.slice(2).map(decodeURIComponent).join("/"), url.origin);
      } catch {
        return text("bad path\n", 400);
      }
    const action = parts[2];
    if (!action && request.method === "GET") return json(this.#status(id, url.origin));
    if (action === "create" && request.method === "POST") {
      const status = this.#get("status") as Status | undefined;
      const started = Number(this.#get("started") ?? 0);
      const busy =
        status === "done" ||
        status === "queued" ||
        ((status === "running" || status === "receiving") && Date.now() - started < STALE_MS);
      if (busy) {
        await request.body?.cancel();
        return json(this.#status(id, url.origin));
      }
      // Claimed before the first await: a second create meanwhile sees "receiving" and waits on
      // this one instead of writing the same inputs over it.
      this.#set("status", "receiving");
      this.#set("started", String(Date.now()));
      this.#set("error", "");
      const entries = await unzip(new Uint8Array(await request.arrayBuffer()));
      await this.input.remove("/");
      await this.output.remove("/");
      this.ctx.storage.sql.exec("DELETE FROM job_log");
      for (const [p, b] of entries) await this.input.write(p, [b]);
      this.#set("spec", request.headers.get("x-build-spec") ?? "{}");
      const bytes = this.input.totalSize("/");
      const max = Number(this.env.IN_OBJECT_BUILD_MAX_BYTES ?? 8_000_000);
      const asked = url.searchParams.get("tier");
      const tier = asked === "runner" || (asked !== "object" && bytes > max) ? "runner" : "object";
      this.#set("tier", tier);
      this.#log(`inputs: ${entries.size} files, ${(bytes / 1e6).toFixed(1)} MB → tier ${tier}`);
      if (tier === "runner") {
        this.#set("status", "queued");
        await stubOf(this.env.BUILDS, QUEUE).fetch(`${url.origin}/builds/${id}/enqueue`, {
          method: "POST",
        });
        return json(this.#status(id, url.origin), { status: 202 });
      }
      await this.#build();
      return json(this.#status(id, url.origin), {
        status: this.#get("status") === "done" ? 200 : 500,
      });
    }
    if (action === "input.zip") {
      return new Response(
        zipStream(this.input.filePaths("/"), (p) => readFile(this.input, p)),
        {
          headers: { "content-type": "application/zip", "x-build-spec": this.#get("spec") ?? "{}" },
        },
      );
    }
    if (action === "output" && request.method === "PUT") {
      // Only a build waiting for a runner takes an output: a finished one is immutable.
      if (this.#get("status") !== "queued") {
        await request.body?.cancel();
        return text(`build ${id} is not waiting for a runner\n`, 409);
      }
      let stats = "null";
      try {
        stats = JSON.stringify(JSON.parse(request.headers.get("x-build-stats") ?? "null"));
      } catch {
        return text("x-build-stats: not JSON\n", 400);
      }
      const entries = await unzip(new Uint8Array(await request.arrayBuffer()));
      await this.output.remove("/");
      for (const [p, b] of entries) await this.output.write(p, [b]);
      this.#set("stats", stats);
      this.#set("status", "done");
      this.#log(`runner uploaded ${entries.size} files`);
      await this.#dequeue(id, url.origin);
      return json(this.#status(id, url.origin));
    }
    if (action === "fail" && request.method === "POST") {
      if (this.#get("status") !== "queued") {
        await request.body?.cancel();
        return text(`build ${id} is not waiting for a runner\n`, 409);
      }
      this.#set("error", (await request.text()).slice(0, 20_000));
      this.#set("status", "failed");
      await this.#dequeue(id, url.origin);
      return json(this.#status(id, url.origin));
    }
    return text("not found\n", 404);
  }

  /** The runner is done with `id`: the queue no longer hands it out. */
  async #dequeue(id: string, origin: string) {
    await stubOf(this.env.BUILDS, QUEUE).fetch(`${origin}/builds/${id}/dequeue`, {
      method: "POST",
    });
  }

  async #build() {
    this.#set("status", "running");
    try {
      const esbuild = await getEsbuild();
      const spec = JSON.parse(this.#get("spec") ?? "{}") as BuildSpec;
      const loader = this.env.LOADER as WorkerLoader | undefined;
      // An Astro build evaluates the project's config: in this realm where it can, else in a
      // Worker Loader isolate (workerd and celld refuse to evaluate code).
      const inLoader = !(await canEvaluate()) && loader;
      const output = await buildAny({
        astroCompiler: () => astroCompilerFromRegistry(registryFetch(this.env)),
        runAstro: inLoader
          ? (packages) =>
              astroInLoader({
                loader: inLoader,
                files: this.input,
                esbuild,
                packages,
                registryFetch: registryFetch(this.env),
                spec: spec.astro,
                log: (m) => this.#log(m),
              })
          : undefined,
        files: this.input,
        esbuild,
        packages: defaultPackages(registryFetch(this.env)),
        spec,
        log: (m) => this.#log(m),
      });
      await this.output.remove("/");
      for (const [p, b] of output.files) await this.output.write(p, [b]);
      this.#set(
        "stats",
        JSON.stringify({ ...output.stats, ...(output.astro ? { astro: output.astro } : {}) }),
      );
      this.#set("status", "done");
    } catch (e) {
      this.#set("error", String((e as Error).stack ?? e));
      this.#set("status", "failed");
      this.#log(`failed: ${(e as Error).message}`);
    }
  }

  #claim(origin: string): Response {
    const sql = this.ctx.storage.sql;
    // A claim older than 30 minutes is given out again (the runner went away).
    const row = sql
      .exec<{ id: string }>(
        "SELECT id FROM queue WHERE claimed = 0 OR claimed < ? ORDER BY at LIMIT 1",
        Date.now() - 30 * 60_000,
      )
      .toArray()[0];
    if (!row) return new Response(null, { status: 204 });
    sql.exec("UPDATE queue SET claimed = ? WHERE id = ?", Date.now(), row.id);
    return json({
      id: row.id,
      input: `${origin}/builds/${row.id}/input.zip`,
      output: `${origin}/builds/${row.id}/output`,
    });
  }

  async #serveOutput(id: string, path: string, origin: string): Promise<Response> {
    if (this.#get("status") !== "done") return json(this.#status(id, origin), { status: 404 });
    if (path === "") return json(this.output.filePaths("/"));
    if (path === "project.zip") {
      return new Response(
        zipStream(this.output.filePaths("/"), (p) => readFile(this.output, p)),
        {
          headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="build-${id}.zip"`,
          },
        },
      );
    }
    if (path === "loader.json") {
      const config = JSON.parse(
        new TextDecoder().decode(await readFile(this.output, "/wrangler.json")),
      );
      const code = new TextDecoder().decode(await readFile(this.output, "/worker.js"));
      return json({
        compatibilityDate: config.compatibility_date ?? "2026-02-24",
        compatibilityFlags: config.compatibility_flags ?? [],
        mainModule: "worker.js",
        modules: { "worker.js": code },
      });
    }
    const p = `/${path}`;
    const st = await this.output.stats(p);
    if (st?.kind !== "file") return text("not found\n", 404);
    return new Response((await readFile(this.output, p)) as BodyInit, {
      headers: {
        "content-type": mimeOf(p),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }
}
