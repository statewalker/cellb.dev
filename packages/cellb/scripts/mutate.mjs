// Mutation harness: each mutant injects a known defect; the suite must fail for every one.
import { runMutants } from "./mutation-sandbox.mjs";

const mutants = [
  ["input gate never closes", "src/core/gates.ts", "this.#locks++;", "this.#locks += 0;"],
  [
    "gate released on microtask",
    "src/core/gates.ts",
    "setTimeout(() => {\n      this.#locks--;",
    "queueMicrotask(() => {\n      this.#locks--;",
  ],
  [
    "implicit txn commits per statement",
    "src/core/sql-storage.ts",
    "queueMicrotask(() => this.commit());\n  }\n}",
    "this.commit();\n  }\n}",
  ],
  [
    "transactionSync no rollback",
    "src/core/sql-storage.ts",
    "this.#driver.exec(`ROLLBACK TO ${sp}`, []);\n      this.#driver.exec(`RELEASE ${sp}`, []);\n      throw e;",
    "this.#driver.exec(`RELEASE ${sp}`, []);\n      throw e;",
  ],
  [
    "output gate not awaited",
    "src/core/object-host.ts",
    "await this.#out.barrier();",
    "void this.#out.barrier().catch(() => {});",
  ],
  [
    "events start without the pump",
    "src/core/object-host.ts",
    "while (this.#queue.length && this.#gate.isOpen)",
    "while (this.#queue.length)",
  ],
  [
    "remote stubs always address by id",
    "src/transport/cells-http.ts",
    "idFromName(className, id.name).equals(id)",
    "false",
  ],
  [
    "scheme not restored on the host",
    "src/transport/cells-http.ts",
    "if (!proto) return req;",
    "return req;",
  ],
  [
    "control headers leak into the DO",
    "src/transport/cells-http.ts",
    "if (!changed) return req;",
    "return req;",
  ],
  [
    "remote errors returned instead of thrown",
    "src/transport/cells-http.ts",
    'if (res.headers.get(H.kind) === "error") throw deserializeError(await res.json());',
    "",
  ],
  [
    "router: replacing a link keeps old in-flight requests",
    "src/router/cell-router.ts",
    "    if (prev) this.#fail(shard, prev);",
    "",
  ],
  [
    "router: watchdog never invalidates",
    "src/router/cell-router.ts",
    "if (!alive && this.#links.get(shard) === link) this.detach(shard);",
    "void alive;",
  ],
  [
    "lease: taker ignores the skew margin",
    "src/lease/cas-lease.ts",
    "now <= rec.expiresAt + skewMarginMs",
    "now <= rec.expiresAt",
  ],
  [
    "lease: holder has no local deadline",
    "src/lease/cas-lease.ts",
    "    armDeadline();\n    timer = clock.setTimeout(renew, renewEveryMs);",
    "    timer = clock.setTimeout(renew, renewEveryMs);",
  ],
  [
    "lease: claim does not bump the manifest",
    "src/lease/cas-lease.ts",
    'await this.store.put(this.key, body, cur ? { ifMatch: cur.etag } : { ifNoneMatch: "*" })',
    'cur ? { etag: cur.etag } : await this.store.put(this.key, body, { ifNoneMatch: "*" })',
  ],
  [
    "file lease: normal locking mode",
    "src/adapters/sqlite-lease.ts",
    "PRAGMA locking_mode = EXCLUSIVE;",
    "PRAGMA locking_mode = NORMAL;",
  ],
  [
    "router ignores watchOwner",
    "src/router/cell-router.ts",
    "if (token !== undefined && this.#opts.watchOwner)",
    "if (false)",
  ],
  [
    "failed blockConcurrencyWhile does not reset the object",
    "src/core/state.ts",
    "p.catch((e) => this.#onBlockFailure(e));",
    "p.catch(() => {});",
  ],
  [
    "exclusive cell opener ignored",
    "src/adapters/node-sqlite.ts",
    "if (opts.exclusive) this.#db.exec",
    "if (false) this.#db.exec",
  ],
  [
    "registry: youngest candidate owns",
    "src/adapters/registry-lease.ts",
    "a.registeredAt - b.registeredAt ||",
    "b.registeredAt - a.registeredAt ||",
  ],
  [
    "registry: stale entries never expire",
    "src/adapters/registry-lease.ts",
    "if (age > this.#o.staleMs) {",
    "if (false) {",
  ],
  [
    "registry: paused owner keeps ownership",
    "src/adapters/registry-lease.ts",
    "if (!ok) return ac.abort(",
    "if (false) return ac.abort(",
  ],
  [
    "backup: saves unchanged cells",
    "src/core/object-host.ts",
    "|| this.#seq === this.#backedUpSeq)",
    ")",
  ],
  [
    "backup: snapshots inside a transaction",
    "src/core/object-host.ts",
    "if (this.#sql.held) return Promise.resolve();",
    "",
  ],
  ["backup: no restore on open", "src/core/object-host.ts", "if (empty) {", "if (false) {"],
  [
    "backup: close() skips the final backup",
    "src/core/runtime.ts",
    'await backupAll("close");',
    "",
  ],
  [
    "ws: Response ignores status 101",
    "src/ws/server.ts",
    "    return this.#status;",
    "    return super.status;",
  ],
  [
    "ws: server does not echo the close handshake",
    "src/ws/server.ts",
    "    if (wasOpen)\n      this[kPort]!.postMessage(",
    "    if (false)\n      this[kPort]!.postMessage(",
  ],
  [
    "ws: failed connect emits no error event",
    "src/ws/client.ts",
    '    this.#emit(new Event("error"), this.onerror);',
    "",
  ],
  [
    "ws routing: cross-shard port not forwarded",
    "src/router/cell-router.ts",
    'ctl.postMessage(m, m.t === "ws-accept" ? [m.port as unknown as Transferable] : []);',
    "void ctl;",
  ],
  [
    "ws routing: Upgrade not carried across links",
    "src/router/shard-host.ts",
    'headers.set(H.upgrade, "websocket");',
    "",
  ],
  ["ws heartbeat: client never pings", "src/ws/client.ts", "if (!heartbeatMs) return;", "return;"],
  [
    "ws heartbeat: server never gives up",
    "src/ws/server.ts",
    "if (Date.now() - this.#lastPing > 3 * hb) this.#gone();",
    "",
  ],
  [
    "ws client: duplicate subprotocols accepted",
    "src/ws/client.ts",
    "if (seen.has(p.toLowerCase()))",
    "if (false)",
  ],
  [
    "ws client: URL fragment accepted",
    "src/ws/client.ts",
    'if (u.hash || String(url).includes("#"))',
    "if (false)",
  ],
  [
    "stub args not cloned",
    "src/core/namespace.ts",
    "const copied = cross(args);",
    "const copied = args;",
  ],
];
const cmd = "npx vitest run";
const survived = runMutants(mutants, cmd);
process.exit(survived ? 1 : 0);
