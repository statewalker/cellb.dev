// Linux /proc readings for the capacity runs (as cellb's browser capacity probes do).
import { readdirSync, readFileSync } from "node:fs";

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};
const kb = (text: string, key: string) =>
  Number(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text)?.[1] ?? 0);

/** Memory the machine can still give, in MB. */
export const availableMb = () => Math.round(kb(read("/proc/meminfo"), "MemAvailable") / 1024);
export const totalMb = () => Math.round(kb(read("/proc/meminfo"), "MemTotal") / 1024);

/** Proportional set size of a process, in MB (shared pages divided among their sharers). */
export const pssMb = (pid: number | "self" = "self") =>
  Math.round(kb(read(`/proc/${pid}/smaps_rollup`), "Pss") / 1024);

/** Threads of a process (Node worker threads, Wasmer's pool workers among them). */
export const threads = (pid: number | "self" = "self") =>
  Number(/^Threads:\s+(\d+)/m.exec(read(`/proc/${pid}/status`))?.[1] ?? 0);

/** PSS of every Chromium process and of its renderers, in MB. */
export function chromiumPss() {
  let all = 0;
  let renderer = 0;
  let rendererThreads = 0;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const cmd = read(`/proc/${name}/cmdline`);
    if (!/chrom|headless_shell/i.test(cmd)) continue;
    const p = pssMb(Number(name));
    all += p;
    if (cmd.includes("--type=renderer")) {
      renderer += p;
      rendererThreads += threads(Number(name));
    }
  }
  return { allMb: all, rendererMb: renderer, rendererThreads };
}
