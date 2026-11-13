// Vendored from statewalker-sandbox/apps/flue-capfs-do (2641939, 2026-11-11); changes marked "studio:".
// Flue 2.3 + just-bash 3.6 compatibility. Flue's `grep` tool probes `rg --version`; when
// that fails it runs `grep -rnH …`, and just-bash's grep rejects `-H` — so Flue's grep
// returns "No matches found." on ANY just-bash file system (InMemoryFs included). This
// `rg` command answers the probe and translates Flue's rg invocation to just-bash grep.
// Remove once Flue or just-bash fixes it upstream.

import { defineCommand } from "just-bash/browser";

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const rgForFlue = defineCommand("rg", async (args, ctx) => {
  if (args.includes("--version"))
    return { stdout: "ripgrep 14.0.0 (just-bash shim)\n", stderr: "", exitCode: 0 };
  let fixed = false;
  let glob: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a === "--line-number" || a === "-n" || a === "--with-filename" || a === "-H") continue;
    if (a === "--color" || a === "--colour") i++;
    else if (a.startsWith("--color=")) continue;
    else if (a === "--fixed-strings" || a === "-F") fixed = true;
    else if (a === "--glob" || a === "-g") glob = args[++i];
    else if (a.startsWith("-") && rest.length === 0) {
      return {
        stdout: "",
        stderr: `rg (just-bash shim): unsupported option '${a}'\n`,
        exitCode: 2,
      };
    } else rest.push(a);
  }
  const [pattern, ...paths] = rest;
  if (pattern === undefined) return { stdout: "", stderr: "rg: no pattern given\n", exitCode: 2 };
  const cmd = `grep -rn ${fixed ? "-F" : "-E"}${glob ? ` --include=${q(glob)}` : ""} -- ${q(pattern)} ${(paths.length ? paths : ["."]).map(q).join(" ")}`;
  if (!ctx.exec) return { stdout: "", stderr: "rg: nested exec unavailable\n", exitCode: 2 };
  const r = await ctx.exec(cmd, { cwd: ctx.cwd });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
});
