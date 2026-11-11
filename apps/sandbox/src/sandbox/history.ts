// The project's history: a real git repository in `.cellb/history`, inside the project's own FilesApi (so
// on disk for a folder, in OPFS, in S3…), through whatever FilesApi the caller holds: the page
// uses its owner capability. Built with webrun-vcs (pure TypeScript git):
//
//   history   createGitFilesBackend: loose objects, refs and HEAD under .git (git can read them)
//   staging   FileStagingStore: .git/index
//   worktree  createFileWorktree: the project's files, with .gitignore honored
//
// What the IDE needs from it: commit everything (a checkpoint), the log, what changed since the
// last commit, and restoring a commit (a hard reset: files written, files the commit lacks
// removed). `git` is the full webrun-vcs command set for the rest (branches, diff, merge…).

import { Git, ResetMode } from "@statewalker/vcs-commands";
import {
  createFileWorktree,
  createGitFilesBackend,
  FileStagingStore,
} from "@statewalker/vcs-store-files";
import { createMemoryCheckout } from "@statewalker/vcs-working-tree";
import type { FilesApi } from "@statewalker/webrun-files";

export interface CommitInfo {
  id: string;
  message: string;
  /** Seconds since the epoch. */
  time: number;
  author: string;
}

export interface Changes {
  added: string[];
  changed: string[];
  removed: string[];
}

/**
 * The sandbox's own git directory: never the project's `.git` (a folder may be a repository of
 * its own, with its branches: checkpoints must not land there), and no file of the project is
 * written for it (its ignores are in `info/exclude`, not a `.gitignore`).
 */
export const HISTORY_DIR = ".cellb/history";
const EXCLUDE = ".cellb\n.git\nnode_modules\n.wrangler\n.astro\ndist\n.turbo\n.cache\n.DS_Store\n";

export interface ProjectHistory {
  git: Git;
  /** Commits every change (a checkpoint); undefined when nothing changed since the last one. */
  commitAll(
    message: string,
    author?: { name: string; email: string },
  ): Promise<CommitInfo | undefined>;
  log(max?: number): Promise<CommitInfo[]>;
  /** What changed since the last commit (it stages everything to compare). */
  changes(): Promise<Changes>;
  /** The project's files as they were at this commit. */
  restore(id: string): Promise<void>;
  /** A file's bytes at a commit, or undefined. */
  fileAt(id: string, path: string): Promise<Uint8Array | undefined>;
  /**
   * Pushes the history (its main branch) to a git remote over smart HTTP: any server, or GitHub
   * through a proxy that adds CORS headers. A token goes as HTTP Basic `x-access-token:<token>`.
   */
  push(
    remote: string,
    opts?: { branch?: string; token?: string; force?: boolean },
  ): Promise<PushInfo>;
}

export interface PushInfo {
  remote: string;
  branch: string;
  commit?: string;
  ok: boolean;
  message?: string;
}

export async function openHistory(files: FilesApi): Promise<ProjectHistory> {
  const exists = await files.exists(`/${HISTORY_DIR}/HEAD`);
  const { history } = await createGitFilesBackend({
    files,
    gitDir: HISTORY_DIR,
    create: !exists,
  } as never);
  await history.initialize();
  // What the history never takes in (the project's own .gitignore files are honored too).
  if (!(await files.exists(`/${HISTORY_DIR}/info/exclude`)))
    await files.write(`/${HISTORY_DIR}/info/exclude`, [new TextEncoder().encode(EXCLUDE)]);
  const staging = new FileStagingStore(files, `${HISTORY_DIR}/index`);
  if (exists) await staging.read();
  const worktree = createFileWorktree({
    files,
    rootPath: "",
    blobs: history.blobs,
    trees: history.trees,
    gitDir: HISTORY_DIR,
  });
  const checkout = createMemoryCheckout({ staging } as never);
  const workingCopy = {
    history,
    staging,
    worktree,
    stash: {},
    config: {},
    checkout,
    async getHead() {
      return (await history.refs.resolve("HEAD"))?.objectId;
    },
    async getCurrentBranch() {
      const ref = await history.refs.get("HEAD");
      if (ref && "target" in ref) return String(ref.target).replace("refs/heads/", "");
      return undefined;
    },
    async setHead() {},
    async isDetachedHead() {
      return false;
    },
    async getMergeState() {},
    async getRebaseState() {},
    async getCherryPickState() {},
    async getRevertState() {},
    async hasOperationInProgress() {
      return false;
    },
  };
  const git = Git.fromWorkingCopy(workingCopy as never);
  const head = async () => (await history.refs.resolve("HEAD"))?.objectId as string | undefined;
  const info = async (id: string): Promise<CommitInfo> => {
    const c = (await history.commits.load(id)) as {
      message: string;
      author: { name: string; timestamp: number };
      committer: { timestamp: number };
    };
    return { id, message: c.message.trim(), time: c.committer.timestamp, author: c.author.name };
  };

  async function stageAll() {
    await git.add().addFilepattern(".").call();
    // Files gone from the worktree leave the index too.
    await git.add().addFilepattern(".").setUpdate(true).call();
  }

  // One git operation at a time (they share the index).
  let queue: Promise<unknown> = Promise.resolve();
  const serial =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> => {
      const next = queue.then(() => fn(...a));
      queue = next.catch(() => {});
      return next;
    };

  const api = {
    git,
    async commitAll(
      message: string,
      author: { name: string; email: string } = {
        name: "CellB sandbox",
        email: "sandbox@cellb.dev",
      },
    ): Promise<CommitInfo | undefined> {
      await stageAll();
      const status = await git.status().call();
      if ((await head()) && status.isClean()) {
        await staging.write();
        return undefined;
      }
      const c = await git
        .commit()
        .setMessage(message)
        .setAuthor(author.name, author.email)
        .setAllowEmpty(true)
        .call();
      await staging.write();
      return info(String((c as { id?: string }).id ?? c));
    },
    async log(max = 50): Promise<CommitInfo[]> {
      if (!(await head())) return [];
      const out: CommitInfo[] = [];
      for await (const c of await git.log().setMaxCount(max).call()) {
        const id = String((c as { id?: string }).id ?? "");
        out.push(
          id
            ? await info(id)
            : {
                id,
                message: String((c as { message?: string }).message ?? ""),
                time: 0,
                author: "",
              },
        );
      }
      return out;
    },
    async changes(): Promise<Changes> {
      await stageAll();
      await staging.write();
      const s = await git.status().call();
      return {
        added: [...s.added].sort(),
        changed: [...s.changed].sort(),
        removed: [...s.removed].sort(),
      };
    },
    async restore(id: string): Promise<void> {
      await git.reset().setRef(id).setMode(ResetMode.HARD).call();
      await staging.write();
    },
    async fileAt(id: string, path: string): Promise<Uint8Array | undefined> {
      const commit = (await history.commits.load(id)) as { tree: string };
      let tree = commit.tree;
      const parts = path.split("/").filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        let found: { id: string; mode: number } | undefined;
        for await (const e of (await history.trees.load(tree)) ?? [])
          if ((e as { name: string }).name === parts[i]) found = e as never;
        if (!found) return undefined;
        if (i === parts.length - 1) {
          const chunks: Uint8Array[] = [];
          for await (const ch of (await history.blobs.load(found.id)) ?? []) chunks.push(ch);
          const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
          let at = 0;
          for (const ch of chunks) {
            out.set(ch, at);
            at += ch.length;
          }
          return out;
        }
        tree = found.id;
      }
      return undefined;
    },
  };
  async function push(
    remote: string,
    opts: { branch?: string; token?: string; force?: boolean } = {},
  ): Promise<PushInfo> {
    const branch = opts.branch ?? "main";
    const current = (await workingCopy.getCurrentBranch()) ?? "main";
    const commit = await head();
    if (!commit) throw new Error("nothing to push: commit first");
    let cmd = git
      .push()
      .setRemote(remote)
      .setRefSpecs(`refs/heads/${current}:refs/heads/${branch}`);
    if (opts.token) cmd = cmd.setCredentials({ token: opts.token } as never);
    if (opts.force) cmd = cmd.setForce(true);
    const result = (await cmd.call()) as {
      remoteUpdates?: { status?: string; message?: string }[];
      ok?: boolean;
    };
    const updates = result.remoteUpdates ?? [];
    const failed = updates.find((u) => u.status && !/^(OK|UP_TO_DATE)$/i.test(String(u.status)));
    return {
      remote,
      branch,
      commit,
      ok: !failed,
      message: failed ? `${failed.status} ${failed.message ?? ""}`.trim() : undefined,
    };
  }

  return {
    git,
    push: serial(push),
    commitAll: serial(api.commitAll),
    log: serial(api.log),
    changes: serial(api.changes),
    restore: serial(api.restore),
    fileAt: serial(api.fileAt),
  };
}
