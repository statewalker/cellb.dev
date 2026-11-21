// Python in Wasmer containers, in this tab. Each run gets a fresh container (Wasmer's python/python
// WASIX package) in a Web Worker of its own, prepared ahead of time by an isolated pool and
// terminated after the run: nothing of one run reaches the next. The script sees the page's files
// at /data (a FilesApi on this thread, mounted through the host-filesystem bridge) and no network.
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { createIsolatedPool } from "../../../src/isolated-pool.ts";
import { startServiceWorker } from "../service-worker.ts";
import script from "./script.py?raw";
import data from "./temperatures.csv?raw";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");
const code = $<HTMLTextAreaElement>("code");
const dataEl = $<HTMLTextAreaElement>("data");
const output = $("output");
const filesEl = $("files");
const run = $<HTMLButtonElement>("run");
const logEl = $("log");
const log = (line: string) => {
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
};
const setStatus = (text: string, state = "busy") => {
  status.textContent = text;
  status.dataset.state = state;
  document.body.dataset.state = state;
};

async function main() {
  code.value = script;
  dataEl.value = data;
  try {
    setStatus("starting the ServiceWorker…");
    await startServiceWorker("py"); // cross-origin isolation (Wasmer needs SharedArrayBuffer)
    const pool = createIsolatedPool({
      spawn: () => new Worker(new URL("./wasmer-worker.ts", import.meta.url), { type: "module" }),
      image: { packages: ["python/python"] },
      size: 1,
      warmup: ["python", "-c", "pass"], // downloads and compiles Python before the first run
    });
    setStatus(
      "preparing a Python container (the first time downloads it from the Wasmer registry)…",
    );
    const t0 = performance.now();
    await pool.ready();
    log(`a Python container ready in ${Math.round(performance.now() - t0)} ms`);

    let runs = 0;
    run.disabled = false;
    run.addEventListener("click", async () => {
      run.disabled = true;
      setStatus("running…");
      const files = new MemFilesApi(); // this run's files: nothing else is visible at /data
      await writeText(files, "/temperatures.csv", dataEl.value);
      const r = await pool.run({
        argv: ["python", "-c", code.value],
        files,
        timeoutMs: 30_000,
      });
      runs++;
      output.textContent = r.stdout + (r.stderr ? `\n${r.stderr}` : "");
      output.dataset.exit = String(r.exitCode);
      const listed: string[] = [];
      for await (const e of files.list("/")) {
        if (e.kind !== "file") continue;
        const text = await readText(files, e.path);
        listed.push(
          `${e.path} (${text.length} bytes)${e.path.endsWith(".csv") ? "" : `\n${text}`}`,
        );
      }
      filesEl.textContent = listed.join("\n");
      log(`run ${runs}: exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""} in ${r.ms} ms`);
      setStatus(`ran in ${r.ms} ms · a fresh container is ready for the next run`, "ready");
      run.disabled = false;
    });
    setStatus("ready · run the script", "ready");
    Object.assign(window, { __python: { pool } });
  } catch (e) {
    setStatus(`failed: ${(e as Error).message}`, "error");
    log(String((e as Error).stack ?? e));
  }
}

void main();
