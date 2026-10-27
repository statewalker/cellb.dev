/// <reference lib="webworker" />
// One shard of a project spread over several workers (startProjectShards in the page).
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { serveProjectShard } from "@statewalker/cellb/browser";

serveProjectShard({ sqlite3: () => (sqlite3InitModule as any)({ print() {}, printErr() {} }) });
