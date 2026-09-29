// Child process for the SQLite lock probe. argv: mode file
import { DatabaseSync } from "node:sqlite";
import { isMainThread, threadId, Worker } from "node:worker_threads";

const [mode, file] = process.argv.slice(2);
const db = new DatabaseSync(file);
db.exec("PRAGMA busy_timeout = 0");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const tryIt = (fn) => {
  try {
    return { ok: true, v: fn() };
  } catch (e) {
    return { ok: false, err: String(e.message).slice(0, 60) };
  }
};
if (mode === "hold-exclusive") {
  db.exec("PRAGMA locking_mode = EXCLUSIVE");
  db.exec("CREATE TABLE IF NOT EXISTS t (x)");
  db.exec("INSERT INTO t VALUES (1)"); // first write takes the EXCLUSIVE lock
  out({ ready: true, pid: process.pid });
  setInterval(() => {}, 1 << 30);
} else if (mode === "hold-lease") {
  db.exec("CREATE TABLE IF NOT EXISTS lease (k PRIMARY KEY, owner, epoch)");
  db.exec("BEGIN IMMEDIATE"); // RESERVED lock held as long as the txn stays open
  out({ ready: true, pid: process.pid });
  setInterval(() => {}, 1 << 30);
} else if (mode === "try") {
  out({
    read: tryIt(() => db.prepare("SELECT count(*) c FROM t").get().c),
    write: tryIt(() => db.exec("INSERT INTO t VALUES (2)")),
  });
  process.exit(0);
} else if (mode === "try-lease") {
  out({ acquire: tryIt(() => db.exec("BEGIN IMMEDIATE")) });
  process.exit(0);
}
