// Loading cellb's Node entry point prints no "SQLite is an experimental feature" warning: cellb
// chooses node:sqlite, so the warning would be noise on every start. Other warnings still pass.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const PKG = resolve(import.meta.dirname, "..");
// The sources run under Node's type stripping; `.js` specifiers resolve to their `.ts` files.
const RESOLVE_TS = `export async function resolve(s, c, next) {
  try { return await next(s, c); } catch (e) {
    if (s.startsWith(".") && s.endsWith(".js")) return next(s.slice(0, -3) + ".ts", c);
    throw e;
  }
}`;
const HOOK = `data:text/javascript,${encodeURIComponent(
  `import { register } from "node:module"; register(${JSON.stringify(
    `data:text/javascript,${encodeURIComponent(RESOLVE_TS)}`,
  )});`,
)}`;

test("the Node entry point loads node:sqlite without its experimental warning", () => {
  const entry = pathToFileURL(resolve(PKG, "src/node.ts")).href;
  const script = `
    const { nodeSqliteOpener } = await import(${JSON.stringify(entry)});
    const db = nodeSqliteOpener()("a");
    db.exec("create table t (x)", []);
    process.emitWarning("another experimental thing", "ExperimentalWarning");
  `;
  const r = spawnSync(process.execPath, ["--import", HOOK, "--input-type=module", "-e", script], {
    cwd: PKG,
    encoding: "utf8",
  });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stderr).not.toMatch(/SQLite is an experimental feature/);
  // Only that one warning is held back.
  expect(r.stderr).toMatch(/ExperimentalWarning: another experimental thing/);
});
