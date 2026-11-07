// The "Run it in this tab" panel of an example page: loads the built project, runs it in a
// Dedicated Worker (run-worker.ts) and shows each answer next to the recorded one.
import {
  alignBrowserDifferences,
  alignDocumentedDifferences,
  type Exchange,
} from "../../../packages/cellb/conformance/scenarios";
import type { RunMessage } from "./runner";

/** JSON with sorted keys: answers match when their values do, whatever their key order. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** An exchange as it reads: status, content type and body, or the WebSocket messages. */
function describe(x: Exchange | undefined): string {
  if (!x) return "(no answer)";
  if (x.messages)
    return x.messages.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join("\n");
  const head = [x.status, x.contentType].filter((v) => v != null).join(" · ");
  const headers = x.headers
    ? Object.entries(x.headers)
        .filter(([, v]) => v != null)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")
    : "";
  const body =
    x.body === "" || x.body === undefined
      ? ""
      : typeof x.body === "string"
        ? x.body
        : JSON.stringify(x.body, null, 2);
  return [head, headers, body].filter(Boolean).join("\n");
}

function answerCell(label: string, text: string) {
  const cell = el("div", "min-w-0");
  cell.append(
    el("p", "mb-1 font-mono text-[11px] uppercase tracking-wide text-muted-foreground", label),
    el(
      "pre",
      "max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-5 [overflow-wrap:anywhere]",
      text,
    ),
  );
  return cell;
}

function row(title: string, judge: string, theirs: string, ours: string, same: boolean) {
  const r = el("div", "space-y-2 border-t px-5 py-4");
  const head = el("div", "flex items-center justify-between gap-3");
  head.append(
    el("p", "min-w-0 truncate font-mono text-xs font-medium", title),
    el(
      "span",
      `shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ${same ? "bg-primary/10 text-primary" : "bg-amber-500/15 text-amber-700 dark:text-amber-400"}`,
      same ? `same as ${judge}` : `differs from ${judge}`,
    ),
  );
  const grid = el("div", "grid gap-3 sm:grid-cols-2");
  grid.append(answerCell(`${judge}, recorded`, theirs), answerCell("CellB, in this tab", ours));
  r.append(head, grid);
  return r;
}

export function renderRun(root: HTMLElement) {
  const { name, project, judge = "celld" } = root.dataset;
  const recorded = JSON.parse(root.dataset.recorded ?? "{}") as {
    transcript: Exchange[];
    logs?: string[];
  };
  const button = root.querySelector<HTMLButtonElement>("[data-run-button]");
  const status = root.querySelector<HTMLElement>("[data-run-status]");
  const results = root.querySelector<HTMLElement>("[data-run-results]");
  if (!button || !status || !results) return;
  let worker: Worker | undefined;

  button.addEventListener("click", async () => {
    button.disabled = true;
    results.replaceChildren();
    worker?.terminate();
    const started = performance.now();
    try {
      status.textContent = "loading the project…";
      const w = new Worker(new URL("./run-worker.ts", import.meta.url), { type: "module" });
      worker = w;
      status.textContent = "starting CellB…";
      const done = await new Promise<Extract<RunMessage, { type: "done" }>>((resolve, reject) => {
        w.onerror = (e) => reject(new Error(e.message || "the worker failed to start"));
        w.onmessage = (m: MessageEvent<RunMessage>) => {
          if (m.data.type === "request") status.textContent = `running: ${m.data.label}`;
          else if (m.data.type === "error") reject(new Error(m.data.error));
          else resolve(m.data);
        };
        w.postMessage({ scenario: name, url: new URL(`/built/${project}/`, location.href).href });
      });
      const ours = alignBrowserDifferences(
        alignDocumentedDifferences(done.transcript as Exchange[], recorded.transcript),
        recorded.transcript,
      );
      let same = 0;
      recorded.transcript.forEach((theirs, i) => {
        const match = canonical(ours[i]) === canonical(theirs);
        if (match) same++;
        results.append(row(theirs.request, judge, describe(theirs), describe(ours[i]), match));
      });
      let total = recorded.transcript.length;
      if (recorded.logs) {
        total++;
        const match = canonical(done.logs ?? []) === canonical(recorded.logs);
        if (match) same++;
        results.append(
          row(
            "console output (sorted)",
            judge,
            recorded.logs.join("\n"),
            (done.logs ?? []).join("\n"),
            match,
          ),
        );
      }
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      status.textContent = `${same} of ${total} answers the same as ${judge}'s, in ${secs} s.${
        done.unsupported.length ? ` Not run by CellB: ${done.unsupported.join(", ")}.` : ""
      }`;
    } catch (err) {
      status.textContent = `The run failed: ${(err as Error).message}`;
    } finally {
      worker?.terminate();
      worker = undefined;
      button.disabled = false;
    }
  });
}
