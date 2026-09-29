// Child process: opens a cell through a CellRuntime (exclusive opener) and reports what happened.
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { createCellRuntime } from "../src/index.js";
import { worker } from "./fixtures.js";

const [dir, name, mode] = process.argv.slice(2);
const rt = createCellRuntime({
  worker,
  durableObjects: { COUNTER: { className: "Counter" } },
  openSql: nodeSqliteOpener(dir, { exclusive: true }),
});
try {
  const n = await (rt.env.COUNTER as any).getByName(name).increment(1);
  process.send!({ type: "ok", n });
  if (mode === "hold") setInterval(() => {}, 1 << 30);
  else process.exit(0);
} catch (e) {
  process.send!({ type: "error", message: String((e as Error).message) });
  process.exit(0);
}
