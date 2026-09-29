// Child process: holds a SqliteFileLease until killed.
import { SqliteFileLease } from "../src/adapters/sqlite-lease.js";

const [dir, name, mode] = process.argv.slice(2);
const lease = new SqliteFileLease(dir);
const h = await lease.tryAcquire(name);
process.send!(h ? { type: "held", epoch: h.epoch } : { type: "busy" });
if (!h || mode === "try") process.exit(0);
setInterval(() => {}, 1 << 30); // stay alive holding the OS lock
