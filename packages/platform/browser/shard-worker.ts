/// <reference lib="webworker" />
// The platform's shard: its Durable Objects in SQLite WASM on OPFS.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { serveProjectShard } from "@statewalker/cellb/browser";

serveProjectShard({
  sqlite3: () =>
    // biome-ignore lint/suspicious/noExplicitAny: the init function's options are untyped
    (sqlite3InitModule as any)({
      print() {},
      printErr() {},
      locateFile: (f: string) => `/__cellb/${f}`,
    }),
});
