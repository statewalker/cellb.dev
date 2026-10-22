// Runs mutants in a throw-away COPY of the repo: the working tree is never modified,
// so a killed run (timeout, container stop, kill -9) cannot leave a mutant behind.
import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// vendor/ (Miniflare, celld, html-rewriter bundles) is source the tests need; only the SW
// runtime copy under browser/public/vendor is generated and skipped.
const SKIP = new Set(["node_modules", "test-results", "playwright-report", "dist"]);

export function runMutants(mutants, cmd, { timeoutMs = 600_000 } = {}) {
  const root = process.cwd();
  const work = mkdtempSync(join(tmpdir(), "mutants-"));
  cpSync(root, work, {
    recursive: true,
    filter: (src) =>
      !relative(root, src).startsWith("browser/public/vendor") &&
      !relative(root, src)
        .split("/")
        .some((p) => SKIP.has(p)),
  });
  symlinkSync(join(root, "node_modules"), join(work, "node_modules"));
  let survived = 0;
  try {
    // Baseline: the UNMUTATED copy must pass, or every mutant would be "killed" for the
    // wrong reason (this happened: the copy could not load sqlite3.wasm).
    // Selected mutants that all name their tests: the baseline runs each of those selections
    // (a `-t` pattern belongs to one run), otherwise the whole suite.
    const sel = process.env.MUTANTS?.split(",").map(Number);
    const chosen = mutants.filter((_, i) => !sel || sel.includes(i));
    const runs = chosen.every((m) => m[4])
      ? [...new Set(chosen.map((m) => `${cmd} ${m[4]}`))]
      : [cmd];
    for (const run of runs)
      try {
        execSync(run, { cwd: work, stdio: "pipe", timeout: timeoutMs });
      } catch (e) {
        const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(-2000);
        throw new Error(
          `baseline run failed in the repo copy — fix it before trusting mutants:\n${out}`,
        );
      }
    console.log("baseline  passes in the repo copy");
    // MUTANTS=0,2 runs a subset (keeps each run under a CI/sandbox time limit).
    const only = process.env.MUTANTS?.split(",").map(Number);
    for (const [i, [name, file, from, to, only_]] of mutants.entries()) {
      if (only && !only.includes(i)) continue;
      const path = join(work, file);
      const orig = readFileSync(path, "utf8");
      if (!orig.includes(from)) throw new Error(`mutant "${name}": anchor not found in ${file}`);
      writeFileSync(path, orig.replace(from, to));
      let killed = false;
      try {
        execSync(only_ ? `${cmd} ${only_}` : cmd, { cwd: work, stdio: "pipe", timeout: timeoutMs });
      } catch {
        killed = true;
      }
      writeFileSync(path, orig);
      console.log(`${killed ? "killed  " : "SURVIVED"}  ${name}`);
      if (!killed) survived++;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return survived;
}
