import { CloudUpload, Download, GitBranch, GitPullRequestArrow, Hammer } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { deployWorkflow } from "@/sandbox/deploy";
import { parseRepo, pullFromGitHub, pushToGitHub } from "@/sandbox/github";
import { type ProjectFiles, SKIPPED_DIRS } from "@/sandbox/project";

const KEY = "cellb-sandbox-github";

interface GitSettings {
  repo: string;
  branch: string;
  deployBranch: string;
  token: string;
  remember: boolean;
}

function load(): GitSettings {
  const d = { repo: "", branch: "main", deployBranch: "deploy", token: "", remember: false };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return d;
  }
}

export interface Build {
  files: ProjectFiles;
  summary: string;
}

export function ShipPanel(props: {
  name: string;
  files: () => ProjectFiles;
  build(opts?: { withData?: boolean }): Promise<Build>;
  download(files: ProjectFiles, name: string): void;
  onPulled(name: string, files: ProjectFiles): void;
  log(text: string, level?: "info" | "error"): void;
}) {
  const [s, setS] = useState(load);
  const [message, setMessage] = useState("Update from CellB sandbox");
  const [withData, setWithData] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [status, setStatus] = useState<{ text: string; error?: boolean; url?: string }>();
  const [build, setBuild] = useState<Build>();

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s.remember ? s : { ...s, token: "" }));
    } catch {}
  }, [s]);
  const set = (patch: Partial<GitSettings>) => setS((x) => ({ ...x, ...patch }));

  async function task(
    label: string,
    fn: () => Promise<{ text: string; url?: string } | undefined>,
  ) {
    setBusy(label);
    setStatus(undefined);
    try {
      const r = await fn();
      if (r) {
        setStatus(r);
        props.log(r.text);
      }
    } catch (err) {
      const text = (err as Error).message;
      setStatus({ text, error: true });
      props.log(text, "error");
    } finally {
      setBusy(undefined);
    }
  }

  const target = (branch: string) => {
    if (!s.token) throw new Error("add a GitHub token (fine-grained, Contents: read and write)");
    return { ...parseRepo(s.repo), branch, token: s.token };
  };
  // What git never needs to see, whatever the sandbox loaded.
  const keep = [...SKIPPED_DIRS];

  const doBuild = () =>
    task("build", async () => {
      const b = await props.build({ withData });
      setBuild(b);
      return { text: b.summary };
    });

  const pushSources = () =>
    task("push", async () => {
      const r = await pushToGitHub(target(s.branch), props.files(), { message, keep });
      return {
        text: r.unchanged
          ? `${s.repo}@${s.branch} already has these files`
          : `pushed to ${s.repo}@${s.branch}: ${r.changed} changed, ${r.deleted} deleted (${r.commit.slice(0, 7)})`,
        url: r.url,
      };
    });

  const pushBuild = () =>
    task("push-build", async () => {
      const b = build ?? (await props.build({ withData }));
      setBuild(b);
      const files = new Map(b.files);
      files.set(
        "/.github/workflows/deploy.yml",
        new TextEncoder().encode(deployWorkflow(s.deployBranch)),
      );
      const r = await pushToGitHub(target(s.deployBranch), files, { message: `Build: ${message}` });
      return {
        text: r.unchanged
          ? `${s.repo}@${s.deployBranch} already has this build`
          : `build pushed to ${s.repo}@${s.deployBranch} (${r.commit.slice(0, 7)}): its workflow deploys it to Cloudflare`,
        url: r.url,
      };
    });

  const pull = () =>
    task("pull", async () => {
      const t = target(s.branch);
      const skip = (p: string) => p.split("/").some((part) => SKIPPED_DIRS.has(part));
      const { commit, files } = await pullFromGitHub(t, skip);
      props.onPulled(t.repo, files);
      return {
        text: `opened ${s.repo}@${s.branch} (${commit.slice(0, 7)}): ${files.size} files, in this tab`,
      };
    });

  const field = "bg-background h-8 rounded-md border px-2 font-mono text-xs";
  return (
    <div className="mx-auto grid max-w-3xl gap-6 p-4 text-sm" data-testid="ship-panel">
      <section className="grid gap-3">
        <h2 className="flex items-center gap-2 font-semibold">
          <Hammer className="size-4" /> Deployable build
        </h2>
        <p className="text-muted-foreground">
          The server bundled into one Worker module, the client compiled into static assets: a
          folder that <code className="font-mono">wrangler deploy</code> (Cloudflare),{" "}
          <code className="font-mono">celld</code> and cellb on Node (
          <code className="font-mono">serve.mjs</code>) run as is.
        </p>
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="accent-primary"
            aria-label="Include the preview's data"
            checked={withData}
            onChange={(e) => {
              setWithData(e.target.checked);
              // A build made with the other choice is not the one to download or push now.
              setBuild(undefined);
            }}
          />
          Include the preview's data: the Durable Objects' databases (not R2 objects), in{" "}
          <code className="font-mono">.cellb-data/</code>, where cellb on Node and the hub start
          from them (Cloudflare and celld do not read them). Pushed with the build when it is
          pushed.
        </label>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={doBuild} disabled={!!busy}>
            <Hammer /> {busy === "build" ? "Building…" : "Build"}
          </Button>
          {build && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => props.download(build.files, `${props.name}-deploy`)}
            >
              <Download /> Download build .zip
            </Button>
          )}
        </div>
        {build && (
          <details className="rounded-md border px-3 py-2" data-testid="build-files">
            <summary className="cursor-pointer select-none">{build.summary}</summary>
            <ul className="mt-2 max-h-56 overflow-auto font-mono text-xs">
              {[...build.files.keys()].sort().map((p) => (
                <li key={p}>{p.slice(1)}</li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="grid gap-3">
        <h2 className="flex items-center gap-2 font-semibold">
          <GitBranch className="size-4" /> GitHub
        </h2>
        <p className="text-muted-foreground">
          Push the project's files as a commit (fast-forward only), or open a branch here. Uses
          GitHub's API from this tab with a fine-grained token (Contents: read and write; add
          Workflows to push the deploy workflow).
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1">
            <span className="text-muted-foreground text-xs">Repository</span>
            <input
              aria-label="Repository"
              className={field}
              placeholder="owner/repo"
              value={s.repo}
              onChange={(e) => set({ repo: e.target.value })}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-muted-foreground text-xs">Branch</span>
            <input
              aria-label="Branch"
              className={field}
              value={s.branch}
              onChange={(e) => set({ branch: e.target.value })}
            />
          </label>
          <label className="grid gap-1 sm:col-span-2">
            <span className="text-muted-foreground text-xs">
              Token — sent only to api.github.com
            </span>
            <input
              aria-label="GitHub token"
              type="password"
              autoComplete="off"
              className={field}
              value={s.token}
              onChange={(e) => set({ token: e.target.value })}
            />
          </label>
          <label className="grid gap-1 sm:col-span-2">
            <span className="text-muted-foreground text-xs">Commit message</span>
            <input
              aria-label="Commit message"
              className="bg-background h-8 rounded-md border px-2 text-xs"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
          <label className="text-muted-foreground flex items-center gap-2 text-xs sm:col-span-2">
            <input
              type="checkbox"
              className="accent-primary"
              checked={s.remember}
              onChange={(e) => set({ remember: e.target.checked })}
            />
            Remember the token in this browser
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={pushSources} disabled={!!busy || !s.repo}>
            <CloudUpload /> {busy === "push" ? "Pushing…" : `Push to ${s.branch}`}
          </Button>
          <Button size="sm" variant="outline" onClick={pull} disabled={!!busy || !s.repo}>
            <GitPullRequestArrow /> {busy === "pull" ? "Opening…" : `Open ${s.branch} here`}
          </Button>
        </div>
        <div className="grid gap-2 rounded-md border p-3">
          <p className="text-muted-foreground text-xs">
            Deploy through CI: the build goes to its own branch, with a workflow that runs{" "}
            <code className="font-mono">wrangler deploy</code> (repository secrets{" "}
            <code className="font-mono">CLOUDFLARE_API_TOKEN</code>,{" "}
            <code className="font-mono">CLOUDFLARE_ACCOUNT_ID</code>).
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1">
              <span className="text-muted-foreground text-xs">Deploy branch</span>
              <input
                aria-label="Deploy branch"
                className={field}
                value={s.deployBranch}
                onChange={(e) => set({ deployBranch: e.target.value })}
              />
            </label>
            <Button size="sm" variant="outline" onClick={pushBuild} disabled={!!busy || !s.repo}>
              <CloudUpload /> {busy === "push-build" ? "Building and pushing…" : "Build and push"}
            </Button>
          </div>
        </div>
      </section>

      {status && (
        <p role="status" className={status.error ? "text-destructive" : "text-muted-foreground"}>
          {status.text}{" "}
          {status.url && (
            <a className="underline" href={status.url} target="_blank" rel="noopener">
              open on GitHub
            </a>
          )}
        </p>
      )}
    </div>
  );
}
