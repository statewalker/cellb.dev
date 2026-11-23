// PROTOTYPE (statewalker/statewalker-root#236). `pnpm build`: node src/cli.ts <page.md> <out-dir>
import { resolve } from "node:path";
import { buildPage } from "./build.ts";

const [page, out] = process.argv.slice(2);
const result = await buildPage(resolve(page), resolve(out));
for (const e of result.errors) console.error(`${e.file}:${e.line}:${e.column}: ${e.message}`);
if (!result.ok) process.exit(1);
console.log(`built ${out}/index.html`);
