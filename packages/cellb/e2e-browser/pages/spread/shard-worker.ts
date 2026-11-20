/// <reference lib="webworker" />
// One shard of the spread probe's project (startProjectShards in spread.ts). Its `name` (given
// at spawn) is what the project's Task objects record as the worker that ran a task.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { serveProjectShard } from "../../../src/project/browser-shards.ts";

serveProjectShard({ sqlite3: () => (sqlite3InitModule as any)({ print() {}, printErr() {} }) });
