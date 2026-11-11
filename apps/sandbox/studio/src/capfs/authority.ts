// Vendored from statewalker-sandbox/apps/flue-capfs-do (2641939, 2026-11-11); changes marked "studio:".
// The authorization core, owned by the Workspace Durable Object. It holds the root key,
// the durable session state (mode, revocations) and a cache of verified tokens. Both
// transports go through it: an in-runtime FilteredFiles stub and a token-string call.

import { Biscuit, generateKeypair, type VerifiedBiscuit } from "@statewalker/webrun-biscuit";
import { asResource, fsError, join, normalise } from "./path.ts";
import { authorityBlock, isMode, MODES, OPS, type Op } from "./policy.ts";
import type { DirEntryStat, SqlFs } from "./sql-fs.ts";

interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export interface SessionInfo {
  session: string;
  user: string;
  mode: string;
  revokedAll: boolean;
  revokedIds: string[];
  model: ModelInfo;
}

/** The session's model right and budget (null: unlimited), and what it has used. */
export interface ModelInfo {
  allowed: boolean;
  turnsLeft: number | null;
  tokensLeft: number | null;
  used: { turns: number; input: number; output: number };
}

/** `model` when a session starts: false (default), true (unlimited) or a budget. */
export type ModelGrant = boolean | { turns?: number; tokens?: number };

export interface ModelUsage {
  input?: number;
  output?: number;
}

export type ModelAction = "grant" | "reserve" | "charge";

const budget = (v: unknown, what: string): number | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    throw fsError("EINVAL", `model ${what} must be a whole number >= 0`);
  return v;
};

export class Authority {
  #sql: SqlLike;
  #secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
  // Verified tokens, keyed by the token string (immutable); bounded.
  #verified = new Map<string, Promise<VerifiedBiscuit>>();
  stats = { authorizations: 0, verifications: 0 };

  constructor(sql: SqlLike) {
    this.#sql = sql;
    sql.exec("CREATE TABLE IF NOT EXISTS cap_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    sql.exec(`CREATE TABLE IF NOT EXISTS cap_sessions (
      session TEXT PRIMARY KEY, user TEXT NOT NULL, mode TEXT NOT NULL,
      revoked_all INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)`);
    sql.exec(
      "CREATE TABLE IF NOT EXISTS cap_revoked (session TEXT NOT NULL, rid TEXT NOT NULL, PRIMARY KEY (session, rid))",
    );
    // Schema 2 adds the model right and budget to cap_sessions. A store from before has no
    // 'schema' row: its columns are added once (a column already there, from a run that stopped
    // before the row was written, is skipped), then the row is written.
    const schema = Number(
      sql.exec("SELECT value FROM cap_meta WHERE key = 'schema'").toArray()[0]?.value ?? 1,
    );
    if (schema < 2) {
      for (const [col, type] of [
        ["model_right", "INTEGER NOT NULL DEFAULT 0"],
        ["model_turns", "INTEGER"],
        ["model_tokens", "INTEGER"],
        ["used_turns", "INTEGER NOT NULL DEFAULT 0"],
        ["used_input", "INTEGER NOT NULL DEFAULT 0"],
        ["used_output", "INTEGER NOT NULL DEFAULT 0"],
      ] as const) {
        try {
          sql.exec(`ALTER TABLE cap_sessions ADD COLUMN ${col} ${type}`);
        } catch (e) {
          if (!/duplicate column/i.test(String((e as Error)?.message ?? e))) throw e;
        }
      }
      sql.exec("INSERT OR REPLACE INTO cap_meta (key, value) VALUES ('schema', '2')");
    }
    // The root key never leaves this cell.
    const rows = sql
      .exec("SELECT key, value FROM cap_meta WHERE key IN ('secret', 'public')")
      .toArray();
    const get = (k: string) => rows.find((r) => r.key === k)?.value as string | undefined;
    if (get("secret") && get("public")) {
      this.#secretKey = unb64(get("secret") as string);
      this.publicKey = unb64(get("public") as string);
    } else {
      const kp = generateKeypair();
      this.#secretKey = kp.secretKey;
      this.publicKey = kp.publicKey;
      sql.exec(
        "INSERT OR REPLACE INTO cap_meta (key, value) VALUES ('secret', ?), ('public', ?)",
        b64(kp.secretKey),
        b64(kp.publicKey),
      );
    }
  }

  // ---- sessions (issuer side) ----

  startSession(
    user: string,
    rights: string[],
    mode = "yolo",
    model: ModelGrant = false,
  ): { session: string; token: string } {
    if (!isMode(mode)) throw fsError("EINVAL", `unknown mode '${mode}'`);
    if (typeof user !== "string" || !user) throw fsError("EINVAL", "user is required");
    if (!Array.isArray(rights) || rights.some((r) => typeof r !== "string")) {
      throw fsError("EINVAL", "rights must be an array of paths");
    }
    const clean = rights.map((r) => normalise(r));
    if (model !== undefined && typeof model !== "boolean" && (typeof model !== "object" || !model))
      throw fsError("EINVAL", "model is true, false or { turns?, tokens? }");
    const allowed = model !== false;
    const limits = typeof model === "object" ? model : {};
    const turns = budget(limits.turns, "turns");
    const tokens = budget(limits.tokens, "tokens");
    const session = crypto.randomUUID();
    // Build the token first: a failure leaves no orphan session row.
    const token = Biscuit.build(
      this.#secretKey,
      authorityBlock({ user, session, rights: clean, model: allowed }),
    ).toBase64();
    this.#sql.exec(
      "INSERT INTO cap_sessions (session, user, mode, created, model_right, model_turns, model_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)",
      session,
      user,
      mode,
      Date.now(),
      allowed ? 1 : 0,
      turns,
      tokens,
    );
    return { session, token };
  }

  setMode(session: string, mode: string): SessionInfo {
    if (!isMode(mode)) throw fsError("EINVAL", `unknown mode '${mode}'`);
    this.#sessionRow(session);
    this.#sql.exec("UPDATE cap_sessions SET mode = ? WHERE session = ?", mode, session);
    return this.sessionInfo(session);
  }

  /** Without `rid`, cuts the whole session; with it, cuts one capability and all its descendants. */
  revoke(session: string, rid?: string): SessionInfo {
    this.#sessionRow(session);
    // A revocation id is the hex signature of a block (Ed25519: 64 bytes). It cannot be tied to
    // this session without the token, so only its form is checked.
    if (rid !== undefined && !/^[0-9a-f]{128}$/.test(String(rid))) {
      throw fsError("EINVAL", "invalid revocation id");
    }
    if (rid)
      this.#sql.exec(
        "INSERT OR IGNORE INTO cap_revoked (session, rid) VALUES (?, ?)",
        session,
        rid,
      );
    else this.#sql.exec("UPDATE cap_sessions SET revoked_all = 1 WHERE session = ?", session);
    return this.sessionInfo(session);
  }

  /**
   * Sets what is left of a session's model budget: each field given is set (a number, or null
   * for unlimited); a field left out keeps its value. Only for a session with the model right
   * (the right is a fact of its token, so a budget cannot add it).
   */
  setModelBudget(session: string, limits: { turns?: number | null; tokens?: number | null }) {
    this.#sessionRow(session);
    if (!this.#modelInfo(session).allowed)
      throw fsError("EINVAL", "the session has no model right (start a new session with model)");
    const l = (limits ?? {}) as Record<string, unknown>;
    for (const field of ["turns", "tokens"] as const)
      if (Object.hasOwn(l, field))
        this.#sql.exec(
          `UPDATE cap_sessions SET model_${field} = ? WHERE session = ?`,
          budget(l[field], field),
          session,
        );
    return this.sessionInfo(session);
  }

  #modelInfo(session: string): ModelInfo {
    const r = this.#sql
      .exec(
        "SELECT model_right, model_turns, model_tokens, used_turns, used_input, used_output FROM cap_sessions WHERE session = ?",
        session,
      )
      .toArray()[0];
    if (!r) throw fsError("EACCES", "unknown session");
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return {
      allowed: !!r.model_right,
      turnsLeft: n(r.model_turns),
      tokensLeft: n(r.model_tokens),
      used: {
        turns: Number(r.used_turns),
        input: Number(r.used_input),
        output: Number(r.used_output),
      },
    };
  }

  async #requireModel(token: string) {
    if (!(await this.check(token, "model", "/")))
      throw fsError("EACCES", "permission denied, model");
  }

  /**
   * May this token drive the model, and how much budget is left? The right is the Datalog
   * decision for operation "model" (the session's model_use fact, minus any attenuation), so
   * revocation and attenuation apply as for files. `metered`: the run spends the deployment's
   * budget, so a spent budget refuses it.
   */
  async modelGrant(token: string, metered: boolean) {
    await this.#requireModel(token);
    const info = this.#modelInfo(await this.sessionOf(token));
    if (metered && (info.turnsLeft === 0 || info.tokensLeft === 0))
      throw fsError("EACCES", "the session's model budget is spent");
    return { turnsLeft: info.turnsLeft, tokensLeft: info.tokensLeft };
  }

  /**
   * Before each model request: the right again (revocation stops the next turn), and, when
   * metered, one turn taken from the budget (refused when no turn or no token is left). The
   * cell runs one call at a time, so concurrent runs cannot both take the last turn.
   */
  async modelReserve(token: string, metered: boolean) {
    await this.#requireModel(token);
    const sid = await this.sessionOf(token);
    const info = this.#modelInfo(sid);
    if (metered && (info.turnsLeft === 0 || info.tokensLeft === 0))
      throw fsError("EACCES", "the session's model budget is spent");
    this.#sql.exec(
      `UPDATE cap_sessions SET used_turns = used_turns + 1${
        metered && info.turnsLeft !== null ? ", model_turns = model_turns - 1" : ""
      } WHERE session = ?`,
      sid,
    );
    const left = this.#modelInfo(sid);
    return { turnsLeft: left.turnsLeft, tokensLeft: left.tokensLeft };
  }

  /**
   * After each model request: the tokens it used (input counts cached and cache-written
   * prompt tokens), recorded for the token's session whatever its right is now, and taken from
   * the token budget when metered.
   */
  async modelCharge(token: string, usage: ModelUsage, metered: boolean) {
    const sid = await this.sessionOf(token); // a valid token of this workspace; no right needed
    const count = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 1e9) : 0;
    const input = count(usage?.input);
    const output = count(usage?.output);
    this.#sql.exec(
      `UPDATE cap_sessions SET used_input = used_input + ?, used_output = used_output + ?${
        metered
          ? ", model_tokens = CASE WHEN model_tokens IS NULL THEN NULL ELSE MAX(model_tokens - ?, 0) END"
          : ""
      } WHERE session = ?`,
      input,
      output,
      ...(metered ? [input + output] : []),
      sid,
    );
    const info = this.#modelInfo(sid);
    return { turnsLeft: info.turnsLeft, tokensLeft: info.tokensLeft };
  }

  sessionInfo(session: string): SessionInfo {
    const row = this.#sessionRow(session);
    const revokedIds = this.#sql
      .exec("SELECT rid FROM cap_revoked WHERE session = ?", session)
      .toArray()
      .map((r) => String(r.rid));
    return {
      session,
      user: String(row.user),
      mode: String(row.mode),
      revokedAll: !!row.revoked_all,
      revokedIds,
      model: this.#modelInfo(session),
    };
  }

  #sessionRow(session: string) {
    const row = this.#sql
      .exec("SELECT user, mode, revoked_all FROM cap_sessions WHERE session = ?", session)
      .toArray()[0];
    if (!row) throw fsError("EACCES", `unknown session '${session}'`);
    return row;
  }

  // ---- verification (owner side) ----

  verify(token: string): Promise<VerifiedBiscuit> {
    let v = this.#verified.get(token);
    if (!v) {
      this.stats.verifications++;
      v = Promise.resolve()
        .then(() => Biscuit.fromBase64(token).verifyAsync(this.publicKey))
        .catch(() => {
          throw fsError("EACCES", "invalid token");
        });
      this.#verified.set(token, v);
      if (this.#verified.size > 1000)
        this.#verified.delete(this.#verified.keys().next().value as string);
    }
    return v;
  }

  /** The session a token was minted for, read from its authority block only. */
  #sids = new Map<string, string>();
  async sessionOf(token: string): Promise<string> {
    const cached = this.#sids.get(token);
    if (cached) return cached;
    const v = await this.verify(token);
    const facts = v.evaluate("allow if true;").query("s($x) <- session($x)");
    const sid = facts[0]?.terms[0];
    if (!sid || (sid as { t: string }).t !== "str") throw fsError("EACCES", "token has no session");
    const value = String((sid as { v: unknown }).v);
    this.#sids.set(token, value);
    if (this.#sids.size > 1000) this.#sids.delete(this.#sids.keys().next().value as string);
    return value;
  }

  async revocationIds(token: string): Promise<string[]> {
    return (await this.verify(token)).revocationIds;
  }

  /** Datalog decision for one (op, path). Session state is read fresh: mode and revocation apply on the next call. */
  async check(token: string, op: Op, path: string): Promise<boolean> {
    this.stats.authorizations++;
    const v = await this.verify(token);
    const sid = await this.sessionOf(token);
    const row = this.#sql
      .exec("SELECT mode, revoked_all FROM cap_sessions WHERE session = ?", sid)
      .toArray()[0];
    if (!row) throw fsError("EACCES", "unknown session");
    if (row.revoked_all) throw fsError("EACCES", "session revoked");
    const ids = v.revocationIds;
    if (ids.length > 0) {
      const marks = ids.map(() => "?").join(",");
      const hit = this.#sql
        .exec(
          `SELECT 1 FROM cap_revoked WHERE session = ? AND rid IN (${marks}) LIMIT 1`,
          sid,
          ...ids,
        )
        .toArray();
      if (hit.length > 0) throw fsError("EACCES", "capability revoked");
    }
    const policy = MODES[String(row.mode)];
    if (!policy) throw fsError("EACCES", `unknown mode '${String(row.mode)}'`);
    const r = v.authorize(
      // `check if session({sid})` restates the authority block (sid comes from it): kept as a
      // guard should the session ever be supplied by the caller instead.
      `operation({op});\nresource({path});\ncheck if session({sid});\n${policy}`,
      {
        params: { op, path: asResource(path), sid },
      },
    );
    return r.kind === "ok";
  }
}

export type FsRequest =
  | { op: "model"; action: ModelAction; metered?: boolean; usage?: ModelUsage }
  | { op: "call"; method: string; path: string; args?: unknown[] }
  | { op: "readdir"; path: string }
  | { op: "move"; kind: "cp" | "mv"; path: string; dst: string; opts?: unknown };

/** Stream methods, and how many arguments each takes after the path (the owner comes last). */
const STREAM_METHODS: Record<string, number> = {
  openRead: 1,
  readChunk: 2,
  closeRead: 1,
  openWrite: 1,
  writeChunk: 2,
  commitWrite: 1,
  abortWrite: 1,
};

/**
 * The guarded file API for one token. Every entry an operation touches is authorized here, in
 * the owner cell, before the store is called: the path itself, each missing parent directory a
 * write would create, every entry of a recursive rm, and every source and destination entry of
 * a recursive cp/mv (so non-prefix attenuations such as "not /proj/secret/" hold for subtrees
 * too). Only plain data is returned.
 */
/** studio: what a write through the gate changed (the host mirrors it to the folder on disk). */
export type ChangeListener = (path: string, kind: "write" | "delete" | "mkdir") => void;

const WRITE_METHODS = new Set(["writeFile", "writeFileBuffer", "appendFile", "appendFileBuffer"]);

export class FsGate {
  #store: SqlFs;
  #auth: Authority;
  #token: string;
  #onChange?: ChangeListener;
  constructor(store: SqlFs, auth: Authority, token: string, onChange?: ChangeListener) {
    this.#store = store;
    this.#auth = auth;
    this.#token = token;
    this.#onChange = onChange;
  }

  async #require(op: Op, path: string): Promise<void> {
    if (!(await this.#auth.check(this.#token, op, path)))
      throw fsError("EACCES", `permission denied, ${op} '${path}'`);
  }
  async #authorize(op: Op, raw: unknown): Promise<string> {
    const path = normalise(raw);
    await this.#require(op, path);
    return path;
  }
  /** Directories a write would create are writes too. */
  async #requireParents(path: string): Promise<void> {
    for (const p of await this.#store.missingParents(path)) await this.#require("write", p);
  }

  async call(method: string, p: string, ...args: unknown[]): Promise<unknown> {
    const op = Object.hasOwn(OPS, method) ? OPS[method] : undefined;
    if (!op) throw fsError("ENOSYS", `method not available '${method}'`);
    if (method === "readdir") return this.readdir(p);
    if (method === "readdirStat") return this.readdirStat(p);
    // Releasing a stream needs no right: it only gives back what its owner holds (a revoked or
    // read-only capability can still close what it opened). Owner and path still have to match.
    if (method === "closeRead" || method === "abortWrite") {
      // biome-ignore lint/suspicious/noExplicitAny: dispatch over the store's stream methods
      const fn = (this.#store as any)[method] as (...a: unknown[]) => Promise<unknown>;
      return fn.call(this.#store, normalise(p), args[0], this.#token);
    }
    const path = await this.#authorize(op, p);
    const opts = (args[0] ?? {}) as { recursive?: boolean };
    if (
      method === "writeFile" ||
      method === "writeFileBuffer" ||
      method === "appendFile" ||
      method === "appendFileBuffer" ||
      method === "openWrite" ||
      method === "commitWrite" ||
      (method === "mkdir" && opts.recursive)
    ) {
      await this.#requireParents(path);
    }
    // Streams: every chunk is authorized again (above), and a stream belongs to the token that
    // opened it, so its id is useless to any other capability.
    if (Object.hasOwn(STREAM_METHODS, method)) {
      // biome-ignore lint/suspicious/noExplicitAny: dispatch over the store's stream methods
      const fn = (this.#store as any)[method] as (...a: unknown[]) => Promise<unknown>;
      const n = STREAM_METHODS[method] as number;
      const out = await fn.call(this.#store, path, ...args.slice(0, n), this.#token);
      if (method === "commitWrite") this.#onChange?.(path, "write"); // studio
      return out;
    }
    if (method === "rm" && opts.recursive && (await this.#store.exists(path))) {
      for (const e of await this.#store.entries(path)) await this.#require("write", e.path);
    }
    // biome-ignore lint/suspicious/noExplicitAny: dispatch over the store's method table
    const fn = (this.#store as any)[method] as (...a: unknown[]) => Promise<unknown>;
    const out = await fn.call(this.#store, path, ...args);
    // studio: report what changed.
    if (WRITE_METHODS.has(method)) this.#onChange?.(path, "write");
    else if (method === "rm") this.#onChange?.(path, "delete");
    else if (method === "mkdir") this.#onChange?.(path, "mkdir");
    return out;
  }

  /** readdir on an ancestor of a right only shows the children the token may reach. */
  async readdir(p: string): Promise<string[]> {
    const path = await this.#authorize("list", p);
    const names = await this.#store.readdir(path);
    const out: string[] = [];
    for (const name of names)
      if (await this.#auth.check(this.#token, "list", join(path, name))) out.push(name);
    return out;
  }

  /** readdir with each visible entry's stat, in one call (Wasmer lists directories this way). */
  async readdirStat(p: string): Promise<DirEntryStat[]> {
    const path = await this.#authorize("list", p);
    const out: DirEntryStat[] = [];
    for (const e of await this.#store.readdirStat(path))
      if (await this.#auth.check(this.#token, "list", join(path, e.name))) out.push(e);
    return out;
  }

  async move(kind: "cp" | "mv", src: string, dst: string, opts?: unknown): Promise<void> {
    if (kind !== "cp" && kind !== "mv") throw fsError("ENOSYS", `move kind '${String(kind)}'`);
    const s = await this.#authorize("read", src);
    const d = await this.#store.resolveTarget(s, await this.#authorize("write", dst));
    await this.#require("write", d);
    await this.#requireParents(d);
    if (kind === "mv" && d === s) return this.#store.mv(s, d);
    for (const e of await this.#store.entries(s)) {
      await this.#require("read", e.path);
      if (kind === "mv") await this.#require("write", e.path);
      await this.#require("write", d + e.path.slice(s.length));
    }
    // studio: report what changed (a copied or moved tree: each file at its new path).
    const moved = (await this.#store.entries(s))
      .filter((e) => e.kind === "file")
      .map((e) => d + e.path.slice(s.length));
    if (kind === "cp") await this.#store.cp(s, d, opts as { recursive?: boolean });
    else await this.#store.mv(s, d);
    if (kind === "mv") this.#onChange?.(s, "delete");
    for (const p of moved) this.#onChange?.(p, "write");
  }

  /** The model right and budget of this token (see Authority.modelGrant / modelCharge). */
  model(action: ModelAction, metered: boolean, usage?: ModelUsage): Promise<unknown> {
    if (action === "grant") return this.#auth.modelGrant(this.#token, metered);
    if (action === "reserve") return this.#auth.modelReserve(this.#token, metered);
    if (action === "charge") return this.#auth.modelCharge(this.#token, usage ?? {}, metered);
    return Promise.reject(fsError("EINVAL", `unknown model action '${String(action)}'`));
  }

  dispatch(req: FsRequest): Promise<unknown> {
    switch (req?.op) {
      case "call":
        return this.call(req.method, req.path, ...(req.args ?? []));
      case "readdir":
        return this.readdir(req.path);
      case "move":
        return this.move(req.kind, req.path, req.dst, req.opts);
      case "model":
        return this.model(req.action, !!req.metered, req.usage);
      default:
        return Promise.reject(
          fsError("ENOSYS", `unknown request '${String((req as { op?: string })?.op)}'`),
        );
    }
  }
}
