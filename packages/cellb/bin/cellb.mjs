#!/usr/bin/env node
// The `cellb` command: the compiled CLI of the published package (dist/), or the TypeScript
// sources in the repository (Node strips their types; `.js` specifiers resolve to `.ts`).
import { existsSync } from "node:fs";
import { register } from "node:module";

const dist = new URL("../dist/cli.js", import.meta.url);
let entry = dist;
if (!existsSync(dist)) {
  const hook = `export async function resolve(s, c, next) {
    try { return await next(s, c); } catch (e) {
      if (s.startsWith(".") && s.endsWith(".js")) return next(s.slice(0, -3) + ".ts", c);
      throw e;
    }
  }`;
  register(`data:text/javascript,${encodeURIComponent(hook)}`);
  entry = new URL("../src/cli.ts", import.meta.url);
}
const { main } = await import(entry.href);
process.exitCode = await main(process.argv.slice(2));
