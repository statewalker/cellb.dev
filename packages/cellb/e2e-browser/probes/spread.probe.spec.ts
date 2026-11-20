import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium, type Page, test } from "@playwright/test";
import { bundleWorkerForBrowser } from "../../src/project/browser-bundle.ts";
import { readWranglerConfig } from "../../src/project/node-project.ts";
import { availableMB, chromiumMemory } from "./chromium-memory.ts";

// A project's Durable Objects spread over workers: how tasks share out, how many workers start,
// how much they store, whether frames of other origins add room, and cells kept on the host's
// FilesApi. The project is probes/spread/project; the page side is pages/spread/spread.ts.
// statewalker/statewalker-root#177.
//
//   pnpm probes:browser spread -g "tasks"                      SPREAD_WORKERS=1,2,4,8
//   pnpm probes:browser spread -g "how many workers"           SPREAD_STEPS=16,32,64,96,128,160
//   pnpm probes:browser spread -g "stored volume"              SPREAD_VOLUME_MB=4096
//   pnpm probes:browser spread -g "frames"                     SPREAD_FRAMES=4 SPREAD_FRAME_WORKERS=40
//   pnpm probes:browser spread -g "host's FilesApi"            SPREAD_BACKUP_MB=512
//
// SPREAD_JSON=<dir> writes each test's result there. Linux only (memory is read from /proc).
// Every test stops before the machine has less than SPREAD_RESERVE_MB (2048) left.

const reserveMB = Number(process.env.SPREAD_RESERVE_MB ?? 2_048);
const port = Number(process.env.PW_PORT);
const projectDir = resolve(import.meta.dirname, "../../probes/spread/project");
const list = (v: string | undefined, d: number[]) => (v ? v.split(",").map(Number) : d);

let project: { config: unknown; code: string } | undefined;
async function spreadProject() {
  project ??= {
    config: readWranglerConfig(projectDir),
    code: (await bundleWorkerForBrowser(resolve(projectDir, "index.js"), {
      nodeCompat: false,
    })) as string,
  };
  return project;
}

function save(name: string, result: object) {
  console.log(JSON.stringify(result, null, 2));
  if (process.env.SPREAD_JSON) {
    mkdirSync(process.env.SPREAD_JSON, { recursive: true });
    writeFileSync(
      join(process.env.SPREAD_JSON, `${name}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
}

/** Chromium renderer processes on this machine (Linux). */
function renderers() {
  let n = 0;
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d)))
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("--type=renderer")) n++;
    } catch {}
  return n;
}

async function open(page: Page, path = "/spread/") {
  page.on("console", (m) => {
    // Vite's HMR socket cannot connect on the mapped .test names; it falls back, harmlessly.
    if (m.type() === "error" && !/WebSocket connection|\[vite\]/.test(m.text()))
      console.log(`[page] ${m.text().slice(0, 300)}`);
  });
  page.on("crash", () => console.log("[page] crashed"));
  await page.goto(path);
  await page.waitForFunction(() => document.body.dataset.ready === "true");
}

test("tasks shared by workers", async ({ page }) => {
  test.setTimeout(20 * 60_000);
  const p = await spreadProject();
  await open(page);
  const rows: any[] = [];
  for (const workers of list(process.env.SPREAD_WORKERS, [1, 2, 4, 8])) {
    const r = await page.evaluate(
      async ({ p, workers }) => {
        const s = (window as any).__spread;
        const t = performance.now();
        const node = await s.startLocal({ label: `n${workers}`, shards: workers, project: p });
        const startMs = Math.round(performance.now() - t);
        const objects = Array.from({ length: 64 }, (_, i) => `w${workers}-o${i}`);
        // CPU-bound: about 2 ms of work per task, 4 KB written.
        const cpu = await s.runTasks([node], { names: objects, rounds: 8, kb: 4, work: 2_000_000 });
        // Write-bound: 256 KB per task, little work.
        const io = await s.runTasks([node], { names: objects, rounds: 4, kb: 256, work: 0 });
        const stats = await s.objectStats([node], objects);
        await node.close();
        return { workers, startMs, cpu, io, stats };
      },
      { p, workers },
    );
    rows.push({ ...r, ...chromiumMemory() });
    console.log(JSON.stringify(rows.at(-1)));
  }
  save("tasks", {
    date: new Date().toISOString().slice(0, 10),
    test: "tasks shared by workers",
    rows,
  });
});

test("how many workers one page starts with startProjectShards", async ({ page }) => {
  test.setTimeout(30 * 60_000);
  const p = await spreadProject();
  await open(page);
  const base = chromiumMemory();
  const rows: any[] = [];
  let stopped = "all steps passed";
  for (const workers of list(process.env.SPREAD_STEPS, [16, 32, 64, 96, 128, 160])) {
    if (availableMB() < reserveMB + workers * 45) {
      stopped = `machine memory: ${availableMB()} MB left before ${workers} workers`;
      break;
    }
    const r = await page.evaluate(
      async ({ p, workers }) => {
        const s = (window as any).__spread;
        const t = performance.now();
        try {
          const node = await s.startLocal({ label: `m${workers}`, shards: workers, project: p });
          const startMs = Math.round(performance.now() - t);
          const objects = Array.from({ length: workers * 4 }, (_, i) => `m${workers}-o${i}`);
          const run = await s.runTasks([node], { names: objects, rounds: 2, kb: 1, work: 0 });
          (window as any).__close = () => node.close();
          return { ok: run.errorCount === 0, startMs, run };
        } catch (err) {
          return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 300) };
        }
      },
      { p, workers },
    );
    rows.push({
      workers,
      ...r,
      ...chromiumMemory(),
      renderers: renderers(),
      availableMB: availableMB(),
    });
    console.log(JSON.stringify({ ...rows.at(-1), run: { ...r.run, perWorker: undefined } }));
    await page.evaluate(() => (window as any).__close?.()).catch(() => {});
    if (!r.ok) {
      stopped = r.error ?? r.run?.errors?.[0] ?? "failed";
      break;
    }
  }
  for (const r of rows) if (r.run) r.run.perWorker = undefined;
  save("workers", {
    date: new Date().toISOString().slice(0, 10),
    test: "how many workers",
    stopped,
    base,
    rows,
  });
});

test("stored volume in a profile on disk", async () => {
  test.setTimeout(60 * 60_000);
  const maxMB = Number(process.env.SPREAD_VOLUME_MB ?? 4_096);
  const workers = Number(process.env.SPREAD_VOLUME_WORKERS ?? 4);
  const p = await spreadProject();
  // A persistent context: storage on disk, the quota of a real profile (a test's own context is
  // off the record, with a quota of a few GB kept in memory).
  const dir = mkdtempSync(join(tmpdir(), "spread-profile-"));
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: process.env.PW_CHROMIUM,
    args: ["--no-sandbox", "--disable-gpu", "--no-zygote"],
    baseURL: `http://localhost:${port}`,
  });
  try {
    const page = await ctx.newPage();
    await open(page);
    const rows: any[] = [];
    const before = await page.evaluate(() => navigator.storage.estimate());
    await page.evaluate(
      async ({ p, workers }) => {
        const s = (window as any).__spread;
        (window as any).__node = await s.startLocal({ label: "vol", shards: workers, project: p });
      },
      { p, workers },
    );
    let stopped = `reached ${maxMB} MB`;
    const stepMB = 256;
    for (let written = 0; written < maxMB; written += stepMB) {
      // 1 MiB per task, over 64 objects.
      const r = await page.evaluate(async (round) => {
        const s = (window as any).__spread;
        const objects = Array.from({ length: 64 }, (_, i) => `vol-o${i}`);
        const run = await s.runTasks([(window as any).__node], {
          names: objects,
          rounds: 4,
          kb: 1024,
          work: 0,
          concurrency: 16,
        });
        return {
          round,
          run: { ...run, perWorker: undefined },
          estimate: await navigator.storage.estimate(),
        };
      }, written / stepMB);
      rows.push({
        writtenMB: written + stepMB,
        ...r,
        ...chromiumMemory(),
        availableMB: availableMB(),
      });
      console.log(JSON.stringify(rows.at(-1)));
      if (r.run.errorCount) {
        stopped = r.run.errors[0];
        break;
      }
    }
    const stats = await page.evaluate(() =>
      (window as any).__spread.objectStats(
        [(window as any).__node],
        Array.from({ length: 64 }, (_, i) => `vol-o${i}`),
      ),
    );
    save("volume", {
      date: new Date().toISOString().slice(0, 10),
      test: "stored volume",
      workers,
      stopped,
      before,
      stats,
      rows,
    });
  } finally {
    await ctx.close();
  }
});

// Frames of other origins: names under *.test are mapped to this server, and treated as secure
// (OPFS, workers). Same-site frames share the host's site (spread.test); cross-site frames each
// have their own (node<i>.test).
for (const mode of ["same-site", "cross-site"] as const)
  test(`frames of other origins (${mode})`, async () => {
    test.setTimeout(30 * 60_000);
    const frames = Number(process.env.SPREAD_FRAMES ?? 4);
    const perFrame = Number(process.env.SPREAD_FRAME_WORKERS ?? 40);
    const p = await spreadProject();
    const host = `http://app.spread.test:${port}`;
    const frameOrigin = (i: number) =>
      mode === "same-site"
        ? `http://f${i}.spread.test:${port}`
        : `http://f${i}.node${i}.test:${port}`;
    const origins = [host, ...Array.from({ length: frames }, (_, i) => frameOrigin(i))];
    const browser: Browser = await chromium.launch({
      executablePath: process.env.PW_CHROMIUM,
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--no-zygote",
        "--host-resolver-rules=MAP *.test 127.0.0.1",
        `--unsafely-treat-insecure-origin-as-secure=${origins.join(",")}`,
      ],
    });
    try {
      const page = await browser.newPage();
      await open(page, `${host}/spread/`);
      const base = { ...chromiumMemory(), renderers: renderers() };
      const rows: any[] = [];
      let stopped = "all frames started";
      let handle: unknown;
      for (let i = 0; i < frames; i++) {
        if (availableMB() < reserveMB + perFrame * 45) {
          stopped = `machine memory: ${availableMB()} MB left before frame ${i}`;
          break;
        }
        const r = await page.evaluate(
          async ({ p, origin, i, perFrame }) => {
            const s = (window as any).__spread;
            const w = window as any;
            w.__frames ??= [];
            const t = performance.now();
            try {
              const node = await s.startFrame({
                origin,
                label: `f${i}`,
                shards: perFrame,
                project: p,
                timeoutMs: 60_000,
              });
              w.__frames.push(node);
              const startMs = Math.round(performance.now() - t);
              let handle: string | undefined;
              if (i === 0) {
                // Can a frame of another origin write through a directory handle of the host?
                const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(
                  "host-folder",
                  { create: true },
                );
                handle = await node
                  .call("write-handle", dir)
                  .catch((e: Error) => `refused: ${e.message}`);
              }
              const objects = Array.from(
                { length: w.__frames.length * perFrame * 2 },
                (_, k) => `f-o${k}`,
              );
              const run = await s.runTasks(w.__frames, {
                names: objects,
                rounds: 1,
                kb: 1,
                work: 0,
              });
              return {
                ok: run.errorCount === 0,
                startMs,
                handle,
                run: { ...run, perWorker: undefined },
              };
            } catch (err) {
              return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 300) };
            }
          },
          { p, origin: frameOrigin(i), i, perFrame },
        );
        if (r.handle) handle = r.handle;
        rows.push({
          frames: i + 1,
          workers: (i + 1) * perFrame,
          ...r,
          ...chromiumMemory(),
          renderers: renderers(),
          availableMB: availableMB(),
        });
        console.log(JSON.stringify(rows.at(-1)));
        if (!r.ok) {
          stopped = r.error ?? r.run?.errors?.[0] ?? "failed";
          break;
        }
      }
      save(`frames-${mode}`, {
        date: new Date().toISOString().slice(0, 10),
        test: `frames (${mode})`,
        perFrame,
        stopped,
        hostDirectoryHandleInFrame: handle,
        base,
        rows,
      });
    } finally {
      await browser.close();
    }
  });

test("cells on the host's FilesApi, re-sharded", async ({ page }) => {
  test.setTimeout(30 * 60_000);
  const totalMB = Number(process.env.SPREAD_BACKUP_MB ?? 512);
  const p = await spreadProject();
  await open(page, "/labs/spread-backup.html");
  const r = await page.evaluate(
    async ({ p, totalMB }) => {
      const s = (window as any).__spread;
      const w = window as any;
      const folder = await w.__hostFolder(`host-${Date.now().toString(36)}`);
      const bucket = (node: string) => ({
        ltx: "spread-host",
        node,
        files: { module: w.__filesModule, args: { dir: folder } },
      });
      const objects = Array.from({ length: 64 }, (_, i) => `b-o${i}`);
      // 4 workers write; their cells' LTX files go to the host's folder.
      let t = performance.now();
      const a = await s.startLocal({
        label: "b4",
        shards: 4,
        project: p,
        workerUrl: w.__workerUrl,
        bucket: bucket("b4"),
      });
      const rounds = Math.max(1, Math.round((totalMB * 1024) / 256 / objects.length));
      const write = await s.runTasks([a], {
        names: objects,
        rounds,
        kb: 256,
        work: 0,
        concurrency: 16,
      });
      const before = await s.objectStats([a], objects);
      await a.close();
      const writeMs = Math.round(performance.now() - t);
      const folderAfterWrite = await w.__folderBytes(folder);
      // 8 other workers open the same cells from the folder: placement changed, data did not.
      t = performance.now();
      const b = await s.startLocal({
        label: "b8",
        shards: 8,
        project: p,
        workerUrl: w.__workerUrl,
        bucket: bucket("b8"),
      });
      const after = await s.objectStats([b], objects);
      const more = await s.runTasks([b], { names: objects, rounds: 1, kb: 4, work: 0 });
      await b.close();
      return {
        crossOriginIsolated,
        write: { ...write, perWorker: undefined },
        writeMs,
        before,
        folderAfterWrite,
        reopenMs: Math.round(performance.now() - t),
        after,
        more: { ...more, perWorker: undefined },
      };
    },
    { p, totalMB },
  );
  save("host-filesapi", {
    date: new Date().toISOString().slice(0, 10),
    test: "cells on the host's FilesApi",
    ...r,
  });
});
