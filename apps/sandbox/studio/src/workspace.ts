// The owner cell: one Workspace per project. It owns the root key and the sessions (Authority)
// and hands out capabilities: FilteredFiles RpcTargets (by reference, to cells of this runtime)
// or token calls (`fsCall`, from anywhere), both bound to a Biscuit token whose Datalog decides
// every file operation. Adapted from statewalker-sandbox/apps/flue-capfs-do/src/workspace.ts.
//
// studio: the files are not the cell's own. The gate (FsGate) works on a FilesStore over the
// FilesApi the host provides for this workspace (`cellbStudioHost.store(ws)`: the folder on
// disk, memory, OPFS, S3, a composite…); without a host, on the cell's own SQLite
// (SqlFilesApi). Capabilities filter the real files: there is no copy to keep in step.

import { DurableObject, RpcTarget } from "cloudflare:workers";
import { SqlFilesApi } from "@statewalker/cellb-platform-core/sql-files";
import { Biscuit } from "@statewalker/webrun-biscuit";
import type { FilesApi } from "@statewalker/webrun-files";
import {
  Authority,
  type ChangeListener,
  FsGate,
  type FsRequest,
  type ModelAction,
  type ModelGrant,
  type ModelUsage,
} from "./capfs/authority.ts";
import { FilesStore } from "./capfs/files-store.ts";
import { fsError, normalise } from "./capfs/path.ts";
import { attenuationBlock } from "./capfs/policy.ts";
import { studioHost } from "./host-tools.ts";

export class FilteredFiles extends RpcTarget {
  #gate: FsGate;
  #token: string;
  #auth: Authority;
  #store: FilesStore;
  #onChange: ChangeListener;
  constructor(store: FilesStore, auth: Authority, token: string, onChange: ChangeListener) {
    super();
    this.#store = store;
    this.#auth = auth;
    this.#token = token;
    this.#onChange = onChange;
    this.#gate = new FsGate(store, auth, token, onChange);
  }
  call(method: string, path: string, ...args: unknown[]) {
    return this.#gate.call(method, path, ...args);
  }
  readdir(path: string) {
    return this.#gate.readdir(path);
  }
  move(kind: "cp" | "mv", src: string, dst: string, opts?: unknown) {
    return this.#gate.move(kind, src, dst, opts);
  }
  model(action: ModelAction, metered: boolean, usage?: ModelUsage) {
    return this.#gate.model(action, metered, usage);
  }
  /** Delegation: one more Biscuit block; the new capability can only be narrower. */
  async attenuate(datalog: string): Promise<FilteredFiles> {
    const token = Biscuit.fromBase64(this.#token).attenuate(datalog).toBase64();
    await this.#auth.verify(token);
    return new FilteredFiles(this.#store, this.#auth, token, this.#onChange);
  }
  async revocationId(): Promise<string> {
    return (await this.#auth.revocationIds(this.#token)).at(-1) as string;
  }
}

export class Workspace extends DurableObject {
  #auth: Authority;
  #sql: SqlStorage;
  #stores = new WeakMap<FilesApi, FilesStore>();
  #own?: FilesStore;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.#sql = ctx.storage.sql;
    this.#auth = new Authority(ctx.storage.sql);
  }

  /** The store of workspace `ws`: the host's FilesApi for it, else this cell's SQLite. */
  #store(ws: string): FilesStore {
    const host = studioHost();
    const provided = host?.store?.(ws);
    // A host that provides stores provides every workspace's: an unknown one is closed, never
    // an empty store of this cell's own.
    if (!provided && host?.store) throw fsError("ENOENT", `the project '${ws}' is not open`);
    if (provided) {
      let s = this.#stores.get(provided);
      if (!s) {
        s = new FilesStore(provided);
        this.#stores.set(provided, s);
      }
      return s;
    }
    this.#own ??= new FilesStore(new SqlFilesApi(this.#sql, "ws"));
    return this.#own;
  }

  #notify(ws: string): ChangeListener {
    return (path, kind) => studioHost()?.notify?.(ws, path, kind);
  }

  // ---- admin (the host that owns the project, or a deployment's gateway) ----

  async startSession(
    ws: string,
    user: string,
    rights: string[],
    mode?: string,
    model?: ModelGrant,
  ) {
    const started = this.#auth.startSession(user, rights, mode, model);
    const store = this.#store(ws);
    for (const r of rights) {
      const p = normalise(r);
      if (p !== "/" && !(await store.exists(p))) await store.mkdir(p, { recursive: true });
    }
    return started;
  }
  setMode(session: string, mode: string) {
    return this.#auth.setMode(session, mode);
  }
  revoke(session: string, rid?: string) {
    return this.#auth.revoke(session, rid);
  }
  sessionInfo(session: string) {
    return this.#auth.sessionInfo(session);
  }

  // ---- transport 1: capability by reference (cells of this runtime) ----

  async open(
    ws: string,
    token: string,
    narrow?: { scope?: string | string[]; readOnly?: boolean },
  ): Promise<FilteredFiles> {
    await this.#auth.sessionOf(token); // reject forged tokens before handing anything out
    const files = new FilteredFiles(this.#store(ws), this.#auth, token, this.#notify(ws));
    return narrow && (narrow.scope || narrow.readOnly)
      ? files.attenuate(attenuationBlock(narrow))
      : files;
  }

  // ---- transport 2: the token per request (another worker, node or runtime) ----

  async fsCall(
    ws: string,
    token: string,
    req: FsRequest | { op: "revocationId" },
  ): Promise<unknown> {
    if (req?.op === "revocationId") return (await this.#auth.revocationIds(token)).at(-1);
    await this.#auth.sessionOf(token);
    return new FsGate(this.#store(ws), this.#auth, token, this.#notify(ws)).dispatch(
      req as FsRequest,
    );
  }
}
