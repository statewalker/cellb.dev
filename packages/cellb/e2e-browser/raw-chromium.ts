import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

/**
 * A Chromium driven over raw CDP, attached to its pages only. Playwright attaches a DevTools
 * session to every ServiceWorker, and an attached session keeps the worker running: Chromium's
 * idle timeout (a ServiceWorker without events for ~30 s is stopped) never fires under it.
 */
export async function rawChromium() {
  const executable = await chromeBinary();
  const profile = mkdtempSync(join(tmpdir(), "raw-chromium-"));
  const proc: ChildProcess = spawn(
    executable,
    [
      "--headless=new",
      "--no-sandbox",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    // Its own process group, so close() can stop the helper processes with it.
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  // Out of the terminal's group, Chromium no longer gets its Ctrl-C: if the test process ends
  // without close() (an interrupted run), kill Chromium's group and remove its profile on the
  // way out.
  const killGroup = () => {
    try {
      if (proc.pid) process.kill(-proc.pid, "SIGKILL");
    } catch {
      // none left
    }
  };
  const onExit = () => {
    killGroup();
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // left in the temp directory
    }
  };
  process.once("exit", onExit);
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let err = "";
    proc.stderr?.on("data", (d: Buffer) => {
      err += d.toString();
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    proc.on("exit", (code) => reject(new Error(`chromium exited (${code}): ${err}`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let seq = 0;
  const waiting = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    const w = m.id !== undefined ? waiting.get(m.id) : undefined;
    if (!w) return;
    waiting.delete(m.id);
    if (m.error) w.reject(new Error(m.error.message));
    else w.resolve(m.result);
  };
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  return {
    /** Opens a page; `evaluate` runs an expression in it and returns its (awaited) value. */
    async open(url: string) {
      const { targetId } = await send("Target.createTarget", { url });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      return {
        async evaluate<T>(fn: string, arg?: unknown): Promise<T> {
          const r = await send(
            "Runtime.evaluate",
            {
              expression: `(${fn})(${JSON.stringify(arg ?? null)})`,
              awaitPromise: true,
              returnByValue: true,
            },
            sessionId,
          );
          if (r.exceptionDetails)
            throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
          return r.result.value as T;
        },
        async waitFor(fn: string, timeoutMs = 30_000) {
          const until = Date.now() + timeoutMs;
          while (!(await this.evaluate<boolean>(fn))) {
            if (Date.now() > until) throw new Error(`timed out waiting for ${fn}`);
            await new Promise((r) => setTimeout(r, 100));
          }
        },
      };
    },
    async close() {
      // Killing only the main process left its helpers (renderer, GPU, utility) writing to the
      // profile for a moment, and removing it then failed with ENOTEMPTY (statewalker/cellb.dev#195).
      // Ask Chromium to quit, which stops its helpers; then kill whatever is left of its group.
      const exited = new Promise<void>((r) =>
        proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once("exit", () => r()),
      );
      await Promise.race([send("Browser.close").catch(() => {}), sleep(5_000)]);
      if (!(await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)])))
        proc.kill("SIGKILL");
      await exited;
      ws.close();
      process.off("exit", onExit);
      killGroup(); // the group: helpers still running
      rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The Chromium playwright.config.ts picks: PW_CHROMIUM, Playwright's own, @sparticuz/chromium. */
async function chromeBinary(): Promise<string> {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  try {
    if (existsSync(chromium.executablePath())) return chromium.executablePath();
  } catch {
    // not installed
  }
  const packaged = await import("@sparticuz/chromium");
  return packaged.default.executablePath();
}
