// Hypotheses: SQLite file locks give a crash-safe, same-host lease/fence for cells.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

const dir = mkdtempSync(join(tmpdir(), "lockprobe-"));
const child = (mode, file) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [
      "--no-warnings",
      new URL("./sqlite-lock-child.mjs", import.meta.url).pathname,
      mode,
      file,
    ]);
    p.stdout.once("data", (d) => resolve({ p, msg: JSON.parse(String(d).split("\n")[0]) }));
  });
const once = async (mode, file) => (await child(mode, file)).msg;
const inThread = (file) =>
  new Promise((resolve) => {
    const w = new Worker(
      `import { DatabaseSync } from "node:sqlite"; import { parentPort, workerData } from "node:worker_threads";
    const db = new DatabaseSync(workerData); db.exec("PRAGMA busy_timeout = 0");
    let r; try { db.exec("INSERT INTO t VALUES (3)"); r = "write ok"; } catch (e) { r = "blocked: " + e.message.slice(0, 40); }
    parentPort.postMessage(r);`,
      { eval: true, workerData: file },
    );
    w.once("message", (m) => {
      resolve(m);
      w.terminate();
    });
  });

// H1 cell DB in locking_mode=EXCLUSIVE: another PROCESS can neither read nor write
const cell = join(dir, "cell.sqlite");
const holder = await child("hold-exclusive", cell);
console.log("H1 other process while held:", JSON.stringify(await once("try", cell)));
// H3 another THREAD of a process that does not hold it (separate process spawn uses threads? use main thread here)
const { DatabaseSync } = await import("node:sqlite");
console.log("H3 other thread (different process from holder):", await inThread(cell));
// H2 SIGKILL of the holder releases the lock at once
holder.p.kill("SIGKILL");
await new Promise((r) => holder.p.once("exit", r));
console.log("H2 after SIGKILL of holder:", JSON.stringify(await once("try", cell)));

// H4 a dedicated lease DB with an open BEGIN IMMEDIATE: exclusive, crash-released
const leaseDb = join(dir, "shard-0.lease");
new DatabaseSync(leaseDb).exec("CREATE TABLE IF NOT EXISTS lease (k PRIMARY KEY, owner, epoch)");
const leaseHolder = await child("hold-lease", leaseDb);
console.log("H4 second contender while held:", JSON.stringify(await once("try-lease", leaseDb)));
leaseHolder.p.kill("SIGKILL");
await new Promise((r) => leaseHolder.p.once("exit", r));
console.log("H4 after SIGKILL:", JSON.stringify(await once("try-lease", leaseDb)));

// H5 same process, two connections (e.g. two shard hosts in one server): is the in-process contender blocked too?
const same = join(dir, "same.sqlite");
const a = new DatabaseSync(same);
a.exec("PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE t (x); INSERT INTO t VALUES (1)");
console.log("H5 same-process thread vs held connection:", await inThread(same));
const fsType = execFileSync("stat", ["-f", "-c", "%T", dir]).toString().trim();
console.log("filesystem:", fsType);
process.exit(0);
