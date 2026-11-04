/// <reference lib="webworker" />
// One shard of the demo's project: a Dedicated Worker with SQLite WASM on its own OPFS pool.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { serveProjectShard } from "@statewalker/cellb/browser";

serveProjectShard({ sqlite3: () => sqlite3InitModule() });
