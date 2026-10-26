/// <reference lib="webworker" />
// One shard of a project shared by the tabs (joinProjectShards in the page).
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { serveProjectShard } from "../../../src/browser.js";

serveProjectShard({ sqlite3: () => (sqlite3InitModule as any)({ print() {}, printErr() {} }) });
