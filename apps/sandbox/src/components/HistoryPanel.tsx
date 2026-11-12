import {
  CloudDownload,
  CloudUpload,
  GitBranch,
  GitCommitHorizontal,
  History,
  RotateCcw,
} from "lucide-react";
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
  const [remote, setRemote] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("cellb-sandbox-remote") ?? "{}") as {
        url?: string;
        branch?: string;
      };
    } catch {
      return {};
    }
  });
  const [remoteToken, setRemoteToken] = useState("");
  const [pushed, setPushed] = useState<string>();
  const [branches, setBranches] = useState<{ current: string; all: string[] }>();
  const [newBranch, setNewBranch] = useState("");
  const { history, version, log, onRestored } = props;

  const refresh = useCallback(async () => {
    try {
      const h = await history();
      setCommits(await h.log(30));
      setBranches(await h.branches().catch(() => undefined));
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
      {branches && commits.length > 0 && (
        <div className="flex flex-wrap items-end gap-2" data-testid="history-branches">
          <label className="grid gap-1">
            <span className="text-muted-foreground flex items-center gap-1 text-xs">
              <GitBranch className="size-3" /> Branch
            </span>
            <select
              aria-label="Branch"
              className="bg-background h-8 rounded-md border px-2 font-mono text-xs"
              value={branches.current}
              disabled={!!busy}
              onChange={(e) => {
                const name = e.target.value;
                void task("switch", async () => {
                  await (await history()).switchBranch(name);
                  log(`history: switched to ${name}`);
                  onRestored();
                });
              }}
            >
              {branches.all.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <input
            aria-label="New branch"
            className="bg-background h-8 w-40 rounded-md border px-2 font-mono text-xs"
            placeholder="new-branch"
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy || !newBranch.trim()}
            onClick={() =>
              task("branch", async () => {
                await (await history()).createBranch(newBranch.trim());
                log(`history: branch ${newBranch.trim()} made at the current commit`);
                setNewBranch("");
              })
            }
          >
            New branch
          </Button>
        </div>
      )}
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
      <details className="rounded-md border px-3 py-2">
        <summary className="cursor-pointer text-xs select-none">Push to a git remote</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_8rem]">
          <label className="grid gap-1">
            <span className="text-muted-foreground text-xs">
              Remote (smart HTTP; GitHub through a proxy that adds CORS headers)
            </span>
            <input
              aria-label="Remote URL"
              className="bg-background h-8 rounded-md border px-2 font-mono text-xs"
              placeholder="https://git-proxy.example/github.com/owner/repo.git"
              value={remote.url ?? ""}
              onChange={(e) => setRemote((r) => ({ ...r, url: e.target.value }))}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-muted-foreground text-xs">Branch</span>
            <input
              aria-label="Remote branch"
              className="bg-background h-8 rounded-md border px-2 font-mono text-xs"
              placeholder="main"
              value={remote.branch ?? ""}
              onChange={(e) => setRemote((r) => ({ ...r, branch: e.target.value }))}
            />
          </label>
          <label className="grid gap-1 sm:col-span-2">
            <span className="text-muted-foreground text-xs">Token (optional, not stored)</span>
            <input
              aria-label="Remote token"
              type="password"
              autoComplete="off"
              className="bg-background h-8 rounded-md border px-2 font-mono text-xs"
              value={remoteToken}
              onChange={(e) => setRemoteToken(e.target.value)}
            />
          </label>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy || !remote.url || commits.length === 0}
            onClick={() =>
              task("push", async () => {
                try {
                  localStorage.setItem("cellb-sandbox-remote", JSON.stringify(remote));
                } catch {}
                const r = await (await history()).push(remote.url as string, {
                  branch: remote.branch || "main",
                  token: remoteToken || undefined,
                });
                const text = r.ok
                  ? `pushed ${r.commit?.slice(0, 7)} to ${r.branch}`
                  : `push refused: ${r.message}`;
                setPushed(text);
                log(`history: ${text} (${r.remote})`, r.ok ? "info" : "error");
              })
            }
          >
            <CloudUpload /> {busy === "push" ? "Pushing…" : "Push"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy || !remote.url}
            onClick={() =>
              task("pull", async () => {
                const r = await (await history()).pull(remote.url as string, {
                  branch: remote.branch || "main",
                  token: remoteToken || undefined,
                });
                const text = r.ok
                  ? `pulled ${r.branch}: now at ${r.commit?.slice(0, 7)}`
                  : `pull not merged: ${r.message}`;
                setPushed(text);
                log(`history: ${text} (${r.remote})`, r.ok ? "info" : "error");
                if (r.ok) onRestored();
              })
            }
          >
            <CloudDownload /> {busy === "pull" ? "Pulling…" : "Pull"}
          </Button>
          {pushed && (
            <span role="status" className="text-muted-foreground text-xs" data-testid="push-status">
              {pushed}
            </span>
          )}
        </div>
      </details>
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
