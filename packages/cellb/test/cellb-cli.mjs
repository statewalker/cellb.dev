// The `cellb` command from the TypeScript sources, whatever dist/ holds (bin/cellb.mjs prefers a
// built dist/): for tests that spawn cellb nodes.
import { register } from "node:module";

const hook = `export async function resolve(s, c, next) {
  try { return await next(s, c); } catch (e) {
    if (s.startsWith(".") && s.endsWith(".js")) return next(s.slice(0, -3) + ".ts", c);
    throw e;
  }
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);
const { main } = await import(new URL("../src/cli.ts", import.meta.url).href);
process.exitCode = await main(process.argv.slice(2));
