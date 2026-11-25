/// <reference lib="webworker" />
// One shard of the fragment host's pool shared by the tabs (joinFragmentShards in the page).
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { serveFragmentShard } from "../../../src/browser.js";

serveFragmentShard({ sqlite3: () => (sqlite3InitModule as any)({ print() {}, printErr() {} }) });
