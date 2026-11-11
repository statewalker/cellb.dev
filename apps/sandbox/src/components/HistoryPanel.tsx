import { GitCommitHorizontal, History, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Changes, CommitInfo, ProjectHistory } from "@/sandbox/history";

/**
 * The project's git history (`.git` in the project's own files): what changed since the last
 * commit, commit everything, the commits with Restore. Checkpoints made before agent runs are
 * commits too ("Before the agent: …"), so undoing an agent is a Restore.
 */
export function HistoryPanel(props: {
  history: () => Promise<ProjectHistory>;
  /** Changes to the project (its signature): the panel looks again. */
  version: unknown;
  checkpoints: boolean;
  onCheckpoints(on: boolean): void;
  /** After a restore: the page rereads the files and reruns the app. */
  onRestored(): void;
  log(text: string, level?: "info" | "error"): void;
}) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [changes, setChanges] = useState<Changes>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const { history, version, log, onRestored } = props;

  const refresh = useCallback(async () => {
    try {
      const h = await history();
      setCommits(await h.log(30));
      setChanges(await h.changes());
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [history]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the signal to look again
  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  async function task(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
      log(`history: ${(err as Error).message}`, "error");
    } finally {
      setBusy(undefined);
      await refresh();
    }
  }

  const count = changes
    ? changes.added.length + changes.changed.length + changes.removed.length
    : 0;
  return (
    <section className="grid gap-3" data-testid="history-panel">
      <h2 className="flex items-center gap-2 font-semibold">
        <History className="size-4" /> History
      </h2>
      <p className="text-muted-foreground">
        A git repository the sandbox keeps in the project's own files, under{" "}
        <code className="font-mono">.cellb/history</code> (webrun-vcs, through the page's
        capability): on disk for a folder, in browser storage or S3 for those. A project's own{" "}
        <code className="font-mono">.git</code> is left alone. Agents see neither.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid min-w-48 flex-1 gap-1">
          <span className="text-muted-foreground text-xs">
            {changes === undefined
              ? "Looking for changes…"
              : count === 0
                ? "No changes since the last commit"
                : `${count} change${count === 1 ? "" : "s"}: ${[
                    ...changes.added.map((p) => `+${p}`),
                    ...changes.changed.map((p) => `~${p}`),
                    ...changes.removed.map((p) => `-${p}`),
                  ]
                    .slice(0, 6)
                    .join(" ")}${count > 6 ? " …" : ""}`}
          </span>
          <input
            aria-label="Commit message"
            className="bg-background h-8 rounded-md border px-2 text-xs"
            placeholder="What changed"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        <Button
          size="sm"
          disabled={!!busy || (count === 0 && commits.length > 0)}
          onClick={() =>
            task("commit", async () => {
              const c = await (await history()).commitAll(message.trim() || "Update");
              if (c) log(`history: committed ${c.id.slice(0, 7)} ${c.message}`);
              setMessage("");
            })
          }
        >
          <GitCommitHorizontal /> {busy === "commit" ? "Committing…" : "Commit"}
        </Button>
      </div>
      <label className="text-muted-foreground flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          className="accent-primary"
          checked={props.checkpoints}
          onChange={(e) => props.onCheckpoints(e.target.checked)}
        />
        Commit a checkpoint before each agent run
      </label>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <ol className="divide-y rounded-md border" data-testid="history-commits">
        {commits.length === 0 && (
          <li className="text-muted-foreground p-2 text-xs">No commits yet</li>
        )}
        {commits.map((c, i) => (
          <li key={c.id} className="flex items-center gap-2 px-2 py-1.5 text-xs">
            <code className="text-muted-foreground font-mono">{c.id.slice(0, 7)}</code>
            <span className="min-w-0 flex-1 truncate" title={c.message}>
              {c.message}
            </span>
            <span className="text-muted-foreground tabular-nums max-sm:hidden">
              {new Date(c.time * 1000).toLocaleTimeString([], { hour12: false })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={!!busy || (i === 0 && count === 0)}
              aria-label={`Restore ${c.message}`}
              title="The project's files as they were at this commit (changes since are lost unless committed)"
              onClick={() =>
                task(`restore-${c.id}`, async () => {
                  if (
                    count > 0 &&
                    !confirm(`Restore “${c.message}”? ${count} uncommitted change(s) will be lost.`)
                  )
                    return;
                  await (await history()).restore(c.id);
                  log(`history: restored ${c.id.slice(0, 7)} ${c.message}`);
                  onRestored();
                })
              }
            >
              <RotateCcw /> Restore
            </Button>
          </li>
        ))}
      </ol>
    </section>
  );
}
