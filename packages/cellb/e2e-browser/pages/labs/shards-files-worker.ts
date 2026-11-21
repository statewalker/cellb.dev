/// <reference lib="webworker" />
// A shard worker for labs/shards-files.html, served from /labs/ so that it and the LTX store
// worker it starts are cross-origin isolated (vite.config's isolatedLabs keys on the referer).
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { serveProjectShard } from "../../../src/project/browser-shards.ts";

serveProjectShard({ sqlite3: () => (sqlite3InitModule as any)({ print() {}, printErr() {} }) });
