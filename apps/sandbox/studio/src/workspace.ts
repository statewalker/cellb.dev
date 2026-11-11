// The owner cell: one Workspace per project. It owns the files (SqlFs on its own SQLite), the
// root key and the sessions (Authority), and hands out capabilities: FilteredFiles RpcTargets,
// each bound to a Biscuit token whose Datalog decides every file operation. Adapted from
// statewalker-sandbox/apps/flue-capfs-do/src/workspace.ts.
//
// studio: two additions for a host that owns the real folder (the sandbox's page, a git sync):
//   sync(files)     the host's files in (an admin act: no rights checks, no journal entry)
//   changes(since)  what writes through capabilities changed, with the new contents, so the host
//                   can mirror agents' work back to its folder

import { DurableObject, RpcTarget } from "cloudflare:workers";
import { Biscuit } from "@statewalker/webrun-biscuit";
import {
  Authority,
  type ChangeListener,
  FsGate,
  type ModelAction,
  type ModelGrant,
  type ModelUsage,
} from "./capfs/authority.ts";
import { bytesToString } from "./capfs/bytes.ts";
import { normalise } from "./capfs/path.ts";
import { attenuationBlock } from "./capfs/policy.ts";
import { SqlFs } from "./capfs/sql-fs.ts";

export class FilteredFiles extends RpcTarget {
  #gate: FsGate;
  #token: string;
  #auth: Authority;
  #store: SqlFs;
  #onChange: ChangeListener;
  constructor(store: SqlFs, auth: Authority, token: string, onChange: ChangeListener) {
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

/** A file the host sends: text, `{ $b64 }` for bytes, or null to delete it. */
export type SyncValue = string | { $b64: string } | null;

export interface Change {
  seq: number;
  path: string;
  kind: "write" | "delete" | "mkdir";
  /** The file's content now (writes): text, or `$b64` for binary; absent when too large. */
  text?: string;
  $b64?: string;
}

const MAX_CHANGE_BYTES = 4 * 1024 * 1024;
const isText = (b: Uint8Array) => {
  if (b.subarray(0, 8192).includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b);
    return true;
  } catch {
    return false;
  }
};

export class Workspace extends DurableObject {
  #store: SqlFs;
  #auth: Authority;
  #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.#sql = ctx.storage.sql;
    this.#store = new SqlFs(ctx.storage.sql);
    this.#auth = new Authority(ctx.storage.sql);
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS studio_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, kind TEXT NOT NULL)",
    );
  }

  #record: ChangeListener = (path, kind) => {
    this.#sql.exec("INSERT INTO studio_changes (path, kind) VALUES (?, ?)", path, kind);
  };

  // ---- admin (the host: the page that owns the folder, or a deployment's gateway) ----

  async startSession(user: string, rights: string[], mode?: string, model?: ModelGrant) {
    const started = this.#auth.startSession(user, rights, mode, model);
    for (const r of rights) {
      const p = normalise(r);
      if (p !== "/" && !(await this.#store.exists(p))) await this.#store.mkdir(p, { recursive: true });
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

  /**
   * The host's files: each changed file written, each null deleted; with `prune`, every file the
   * host did not list is deleted too (the host's folder is the truth). Returns what changed.
   */
  async sync(files: Record<string, SyncValue>, prune = false) {
    let written = 0;
    let deleted = 0;
    const listed = new Set<string>();
    for (const [raw, value] of Object.entries(files ?? {})) {
      const p = normalise(raw);
      listed.add(p);
      if (value === null) {
        if (await this.#store.exists(p)) {
          await this.#store.rm(p, { recursive: true });
          deleted++;
        }
        continue;
      }
      const next =
        typeof value === "string"
          ? new TextEncoder().encode(value)
          : Uint8Array.from(atob(value.$b64), (c) => c.charCodeAt(0));
      if (await this.#store.exists(p)) {
        const now = await this.#store.readFileBuffer(p);
        if (now.length === next.length && now.every((b, i) => b === next[i])) continue;
      }
      await this.#store.writeFileBuffer(p, next);
      written++;
    }
    if (prune)
      for (const e of await this.#store.entries("/"))
        if (e.kind === "file" && !listed.has(e.path)) {
          await this.#store.rm(e.path, {});
          deleted++;
        }
    return { written, deleted, cursor: this.#cursor() };
  }

  #cursor(): number {
    const row = this.#sql.exec("SELECT MAX(seq) AS seq FROM studio_changes").toArray()[0];
    return Number(row?.seq ?? 0);
  }

  /** What capability writes changed after `since`, the latest change per path, with contents. */
  async changes(since = 0): Promise<{ cursor: number; changes: Change[] }> {
    const rows = this.#sql
      .exec("SELECT seq, path, kind FROM studio_changes WHERE seq > ? ORDER BY seq", since)
      .toArray() as unknown as { seq: number; path: string; kind: Change["kind"] }[];
    const latest = new Map<string, Change>();
    for (const r of rows) {
      latest.delete(r.path);
      latest.set(r.path, { seq: r.seq, path: r.path, kind: r.kind });
    }
    const out: Change[] = [];
    for (const c of latest.values()) {
      if (c.kind === "write") {
        if (!(await this.#store.exists(c.path))) continue; // written, then deleted under a tree
        const bytes = await this.#store.readFileBuffer(c.path);
        if (bytes.length <= MAX_CHANGE_BYTES) {
          if (isText(bytes)) c.text = new TextDecoder().decode(bytes);
          else c.$b64 = bytesToString(bytes, "base64");
        }
      }
      out.push(c);
    }
    return { cursor: rows.at(-1)?.seq ?? since, changes: out };
  }

  // ---- capabilities ----

  /** A capability for the token, attenuated further by `narrow` (e.g. a scope) when given. */
  async open(
    token: string,
    narrow?: { scope?: string | string[]; readOnly?: boolean },
  ): Promise<FilteredFiles> {
    await this.#auth.sessionOf(token); // reject forged tokens before handing anything out
    const files = new FilteredFiles(this.#store, this.#auth, token, this.#record);
    return narrow && (narrow.scope || narrow.readOnly)
      ? files.attenuate(attenuationBlock(narrow))
      : files;
  }
}
