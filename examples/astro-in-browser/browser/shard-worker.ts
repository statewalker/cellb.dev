/// <reference lib="webworker" />
// A shard of the built app: its Worker, run by cellb.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { serveProjectShard } from "@statewalker/cellb/browser";

serveProjectShard({ sqlite3: () => (sqlite3InitModule as any)({ print() {}, printErr() {} }) });
