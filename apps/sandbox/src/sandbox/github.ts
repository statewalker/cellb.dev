// The project to and from a GitHub repository, from the browser tab.
//
// GitHub's git endpoints (`info/refs`, `git-receive-pack`) send no CORS headers, so a tab cannot
// speak smart HTTP to github.com without a proxy (webrun-vcs can, through one). Its REST API does
// allow CORS, and its Git Data endpoints are enough for a snapshot workflow:
//
//   push   blobs for the changed files → a tree (on the branch's tree, files gone are deleted)
//          → a commit whose parent is the branch's head → the branch moved (fast-forward only)
//   pull   the branch's tree (recursive) → the blobs → the project's files
//
// A fine-grained token with "Contents: read and write" on the repository is all it needs. The
// token stays in the tab: it goes to api.github.com only.

export interface GitHubTarget {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  /** API root, for GitHub Enterprise or a test server (default https://api.github.com). */
  api?: string;
  fetch?: typeof fetch;
}

export interface PushResult {
  commit: string;
  url: string;
  changed: number;
  deleted: number;
  /** True when the branch did not exist and was made by this push. */
  created: boolean;
  unchanged?: boolean;
}

/** "owner/repo", "https://github.com/owner/repo(.git)", "git@github.com:owner/repo.git". */
export function parseRepo(input: string): { owner: string; repo: string } {
  const s = input
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const m =
    /^(?:https?:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9-_.]+)\/([A-Za-z0-9-_.]+)$/.exec(s);
  if (!m) throw new Error(`not a GitHub repository: ${input} (write owner/repo)`);
  return { owner: m[1], repo: m[2] };
}

/** The blob id git gives these bytes: sha1("blob <size>\0" + bytes), to skip unchanged files. */
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head);
  all.set(bytes, head.length);
  const digest = await crypto.subtle.digest("SHA-1", all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64.replace(/\s/g, ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export class GitHubError extends Error {
  override name = "GitHubError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function client(t: GitHubTarget) {
  const api = (t.api ?? "https://api.github.com").replace(/\/$/, "");
  const f = t.fetch ?? fetch.bind(globalThis);
  const base = `${api}/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}`;
  return async function gh<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await f(`${base}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${t.token}`,
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let message = res.statusText;
      try {
        message = ((await res.json()) as { message?: string }).message ?? message;
      } catch {}
      throw new GitHubError(`GitHub: ${method} ${path} → ${res.status} ${message}`, res.status);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  };
}

interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

async function branchHead(
  gh: ReturnType<typeof client>,
  branch: string,
): Promise<{ commit: string; tree: string } | undefined> {
  try {
    const ref = await gh<{ object: { sha: string } }>(
      "GET",
      `/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    const commit = await gh<{ tree: { sha: string } }>("GET", `/git/commits/${ref.object.sha}`);
    return { commit: ref.object.sha, tree: commit.tree.sha };
  } catch (err) {
    if (err instanceof GitHubError && (err.status === 404 || err.status === 409)) return undefined;
    throw err;
  }
}

/** Every file of a tree, path (no leading "/") → blob id. */
async function treeFiles(gh: ReturnType<typeof client>, tree: string) {
  const t = await gh<{ tree: TreeEntry[]; truncated: boolean }>(
    "GET",
    `/git/trees/${tree}?recursive=1`,
  );
  if (t.truncated) throw new Error("the repository's tree is too large for the GitHub API");
  return new Map(t.tree.filter((e) => e.type === "blob").map((e) => [e.path, e]));
}

/**
 * Pushes the project as the branch's next commit. Files the project does not have are deleted
 * from the branch, except those under `keep` prefixes (e.g. what the sandbox never loads).
 */
export async function pushToGitHub(
  t: GitHubTarget,
  files: Map<string, Uint8Array>,
  opts: { message: string; keep?: string[]; author?: { name: string; email: string } },
): Promise<PushResult> {
  const gh = client(t);
  let head = await branchHead(gh, t.branch);
  let created = false;
  if (!head) {
    // An empty repository has no git database to write to until it has a commit: the contents
    // API makes the first one. A repository with commits but without this branch: branch off
    // its default branch.
    const info = await gh<{ default_branch: string }>("GET", "");
    const base = await branchHead(gh, info.default_branch);
    if (base) {
      await gh("POST", "/git/refs", { ref: `refs/heads/${t.branch}`, sha: base.commit });
    } else {
      await gh("PUT", "/contents/.gitkeep", {
        message: "Initial commit",
        content: "",
        branch: t.branch,
      });
    }
    created = true;
    head = await branchHead(gh, t.branch);
    if (!head) throw new Error(`could not make the branch ${t.branch}`);
  }

  const remote = await treeFiles(gh, head.tree);
  const keep = opts.keep ?? [];
  const entries: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
  let changed = 0;
  for (const [abs, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const path = abs.replace(/^\/+/, "");
    const sha = await gitBlobSha(bytes);
    const was = remote.get(path);
    if (was?.sha === sha) continue;
    const blob = await gh<{ sha: string }>("POST", "/git/blobs", {
      content: toBase64(bytes),
      encoding: "base64",
    });
    entries.push({
      path,
      mode: was?.mode === "100755" ? "100755" : "100644",
      type: "blob",
      sha: blob.sha,
    });
    changed++;
  }
  let deleted = 0;
  for (const [path, e] of remote) {
    if (files.has(`/${path}`) || keep.some((k) => path === k || path.startsWith(`${k}/`))) continue;
    if (created && path === ".gitkeep") {
      entries.push({ path, mode: e.mode, type: "blob", sha: null });
      continue;
    }
    entries.push({ path, mode: e.mode, type: "blob", sha: null });
    deleted++;
  }
  const url = `https://github.com/${t.owner}/${t.repo}/tree/${t.branch}`;
  if (entries.length === 0)
    return { commit: head.commit, url, changed: 0, deleted: 0, created, unchanged: true };

  const tree = await gh<{ sha: string }>("POST", "/git/trees", {
    base_tree: head.tree,
    tree: entries,
  });
  const commit = await gh<{ sha: string }>("POST", "/git/commits", {
    message: opts.message,
    tree: tree.sha,
    parents: [head.commit],
    ...(opts.author ? { author: opts.author } : {}),
  });
  // Fast-forward only: a branch someone else moved meanwhile is refused, nothing is lost.
  await gh("PATCH", `/git/refs/heads/${encodeURIComponent(t.branch)}`, {
    sha: commit.sha,
    force: false,
  });
  return { commit: commit.sha, url, changed, deleted, created };
}

/** The branch's files (paths with a leading "/"), skipping those `skip` refuses. */
export async function pullFromGitHub(
  t: GitHubTarget,
  skip: (path: string) => boolean = () => false,
): Promise<{ commit: string; files: Map<string, Uint8Array> }> {
  const gh = client(t);
  const head = await branchHead(gh, t.branch);
  if (!head) throw new Error(`${t.owner}/${t.repo} has no branch ${t.branch}`);
  const files = new Map<string, Uint8Array>();
  for (const [path, e] of await treeFiles(gh, head.tree)) {
    if (skip(`/${path}`)) continue;
    const blob = await gh<{ content: string; encoding: string }>("GET", `/git/blobs/${e.sha}`);
    files.set(
      `/${path}`,
      blob.encoding === "base64"
        ? fromBase64(blob.content)
        : new TextEncoder().encode(blob.content),
    );
  }
  return { commit: head.commit, files };
}
