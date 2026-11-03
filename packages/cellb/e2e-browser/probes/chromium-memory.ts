import { readdirSync, readFileSync } from "node:fs";

/**
 * Memory of every Chromium process on this machine, from /proc (Linux only), in MB. PSS counts
 * pages shared between processes once, divided among them. `renderer` is the largest renderer:
 * the page's, which also runs its Dedicated Workers.
 */
export function chromiumMemory() {
  let total = 0;
  let renderer = 0;
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!/chrom/i.test(cmd.split("\0")[0] ?? "")) continue;
      const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
      const pss = Number(/^Pss:\s+(\d+) kB/m.exec(rollup)?.[1] ?? 0);
      total += pss;
      if (cmd.includes("--type=renderer")) renderer = Math.max(renderer, pss);
    } catch {
      // the process exited, or is not ours to read
    }
  }
  return { chromiumPssMB: Math.round(total / 1024), rendererPssMB: Math.round(renderer / 1024) };
}

/** Memory the machine has left, in MB (MemAvailable). */
export function availableMB() {
  const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
  return Math.round(Number(m?.[1] ?? 0) / 1024);
}
