// A process that stops gracefully on SIGINT/SIGTERM through cli.ts's onStopSignals: the stop
// takes a while, as a fleet node's does (drain, release the cells).
import { register } from "node:module";

const hook = `export async function resolve(s, c, next) {
  try { return await next(s, c); } catch (e) {
    if (s.startsWith(".") && s.endsWith(".js")) return next(s.slice(0, -3) + ".ts", c);
    throw e;
  }
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);
const { onStopSignals } = await import(new URL("../../src/cli.ts", import.meta.url).href);
let stops = 0;
const done = onStopSignals(async () => {
  stops++;
  await new Promise((r) => setTimeout(r, 300));
  console.log(`stopped ${stops}`);
});
const alive = setInterval(() => {}, 1_000); // what a node's servers do
console.log("ready");
process.exitCode = await done;
clearInterval(alive);
