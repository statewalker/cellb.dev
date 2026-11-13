import { describe, expect, it } from "vitest";
import { assembleDeploy, deployWorkflow } from "../src/sandbox/deploy";
import { exportClient, importsOf } from "../src/sandbox/export";
import { gitBlobSha, parseRepo, pullFromGitHub, pushToGitHub } from "../src/sandbox/github";
import { decode, encode } from "../src/sandbox/project";

describe("client export", () => {
  it("finds static, dynamic and side-effect imports", () => {
    const code = `import a from "./a.js";\nimport { b, c } from '../b.tsx';\nimport "./side.css";\nexport * from "./re.js";\nconst d = await import("./lazy.ts");`;
    expect(importsOf(code).sort()).toEqual([
      "../b.tsx",
      "./a.js",
      "./lazy.ts",
      "./re.js",
      "./side.css",
    ]);
  });

  it("keeps what the site serves, renames modules a static host would mistype", async () => {
    const site = async (req: Request) => {
      const path = new URL(req.url).pathname;
      const js = { "content-type": "text/javascript" };
      if (path === "/index.html")
        return new Response(
          `<script type="module" src="_modules/~/src/main.tsx"></script><link href="style.css" rel="stylesheet">`,
          {
            headers: { "content-type": "text/html" },
          },
        );
      if (path === "/_modules/~/src/main.tsx")
        return new Response(
          `import { h } from "../../react@19.1.0/index.js";\nimport "./theme.css";\nh();`,
          { headers: js },
        );
      if (path === "/_modules/~/src/theme.css")
        return new Response(`document.head.append("css")`, { headers: js });
      if (path === "/_modules/react@19.1.0/index.js")
        return new Response(`export const h = () => 1;`, { headers: js });
      return new Response("missing", { status: 404 });
    };
    const client = new Map([
      ["/index.html", encode("<script src='./src/main.tsx'></script>")],
      ["/style.css", encode("body{}")],
      ["/src/main.tsx", encode("// source")],
      ["/package.json", encode("{}")],
    ]);
    const out = await exportClient(site, client);
    expect([...out.keys()].sort()).toEqual([
      "/_modules/react@19.1.0/index.js",
      "/_modules/~/src/main.tsx.js",
      "/_modules/~/src/theme.css.js",
      "/index.html",
      "/src/main.tsx",
      "/style.css",
    ]);
    expect(decode(out.get("/index.html") as Uint8Array)).toContain(
      `src="_modules/~/src/main.tsx.js"`,
    );
    const main = decode(out.get("/_modules/~/src/main.tsx.js") as Uint8Array);
    expect(main).toContain(`"./theme.css.js"`);
    expect(main).toContain(`"../../react@19.1.0/index.js"`);
  });

  it("a module that does not compile fails the export", async () => {
    const site = async (req: Request) =>
      new URL(req.url).pathname === "/index.html"
        ? new Response(`<script src="_modules/~/x.ts"></script>`, {
            headers: { "content-type": "text/html" },
          })
        : new Response("SyntaxError", { status: 400 });
    await expect(exportClient(site, new Map([["/index.html", encode("")]]))).rejects.toThrow(
      /did not compile/,
    );
  });
});

describe("deployable folder", () => {
  it("a server build with the client as its assets", () => {
    const out = assembleDeploy({
      name: "tasks",
      server: {
        config: { name: "tasks", main: "worker.js", no_bundle: true, client: "client" },
        files: new Map([
          ["/worker.js", encode("export default {}")],
          ["/wrangler.json", encode("{}")],
        ]),
      },
      client: new Map([["/index.html", encode("<h1>")]]),
    });
    const config = JSON.parse(decode(out.get("/wrangler.json") as Uint8Array));
    expect(config).toEqual({
      name: "tasks",
      main: "worker.js",
      no_bundle: true,
      assets: { directory: "assets" },
    });
    expect([...out.keys()].sort()).toEqual([
      "/DEPLOY.md",
      "/assets/index.html",
      "/serve.mjs",
      "/worker.js",
      "/wrangler.json",
    ]);
  });

  it("a client-only project is an assets-only Worker", () => {
    const out = assembleDeploy({
      name: "site",
      compatibilityDate: "2026-01-01",
      client: new Map([["/a.js", encode("")]]),
    });
    expect(JSON.parse(decode(out.get("/wrangler.json") as Uint8Array))).toEqual({
      name: "site",
      compatibility_date: "2026-01-01",
      assets: { directory: "assets" },
    });
  });

  it("the workflow deploys its own branch", () => {
    const yml = deployWorkflow("deploy");
    expect(yml).toContain("branches: [deploy]");
    expect(yml).toContain(`$\{{ secrets.CLOUDFLARE_API_TOKEN }}`);
  });
});

/** A tiny in-memory GitHub Git Data API: refs, commits, trees, blobs. */
function fakeGitHub(initial?: Record<string, string>) {
  const blobs = new Map<string, string>();
  const trees = new Map<string, { path: string; mode: string; type: "blob"; sha: string }[]>();
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  const refs = new Map<string, string>();
  let n = 0;
  const id = () => (++n).toString(16).padStart(40, "0");
  const calls: string[] = [];
  if (initial) {
    const entries = Object.entries(initial).map(([path, text]) => {
      const sha = `b${id().slice(1)}`;
      blobs.set(sha, btoa(text));
      return { path, mode: "100644", type: "blob" as const, sha };
    });
    const tree = id();
    trees.set(tree, entries);
    const c = id();
    commits.set(c, { tree, parents: [], message: "init" });
    refs.set("main", c);
  }
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/repos\/o\/r/, "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    let m: string[] = [];
    const hit = (re: RegExp) => {
      const found = re.exec(path);
      if (found) m = found;
      return !!found;
    };
    if (method === "GET" && path === "") return json({ default_branch: "main" });
    if (method === "GET" && hit(/^\/git\/ref\/heads\/(.+)$/)) {
      const sha = refs.get(decodeURIComponent(m[1]));
      return sha
        ? json({ object: { sha } })
        : json({ message: "Not Found" }, refs.size ? 404 : 409);
    }
    if (method === "GET" && hit(/^\/git\/commits\/(\w+)$/))
      return json({ tree: { sha: commits.get(m[1])?.tree } });
    if (method === "GET" && hit(/^\/git\/trees\/(\w+)$/))
      return json({ tree: trees.get(m[1]) ?? [], truncated: false });
    if (method === "GET" && hit(/^\/git\/blobs\/(\w+)$/))
      return json({ content: blobs.get(m[1]), encoding: "base64" });
    if (method === "POST" && path === "/git/blobs") {
      const bytes = Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0));
      const sha = await gitBlobSha(bytes);
      blobs.set(sha, body.content);
      return json({ sha }, 201);
    }
    if (method === "POST" && path === "/git/trees") {
      const base = new Map((trees.get(body.base_tree) ?? []).map((e) => [e.path, e]));
      for (const e of body.tree) {
        if (e.sha === null) base.delete(e.path);
        else base.set(e.path, e);
      }
      const sha = id();
      trees.set(sha, [...base.values()]);
      return json({ sha }, 201);
    }
    if (method === "POST" && path === "/git/commits") {
      const sha = id();
      commits.set(sha, body);
      return json({ sha }, 201);
    }
    if (method === "PATCH" && hit(/^\/git\/refs\/heads\/(.+)$/)) {
      refs.set(decodeURIComponent(m[1]), body.sha);
      return json({});
    }
    if (method === "POST" && path === "/git/refs") {
      refs.set(body.ref.replace("refs/heads/", ""), body.sha);
      return json({}, 201);
    }
    if (method === "PUT" && path === "/contents/.gitkeep") {
      const blob = id();
      blobs.set(blob, "");
      const tree = id();
      trees.set(tree, [{ path: ".gitkeep", mode: "100644", type: "blob", sha: blob }]);
      const c = id();
      commits.set(c, { tree, parents: [], message: body.message });
      refs.set(body.branch, c);
      return json({}, 201);
    }
    return json({ message: `unexpected ${method} ${path}` }, 500);
  }) as typeof fetch;
  const filesAt = (branch: string) => {
    const tree = trees.get(commits.get(refs.get(branch) as string)?.tree as string) ?? [];
    return Object.fromEntries(tree.map((e) => [e.path, atob(blobs.get(e.sha) as string)]));
  };
  return { fetchImpl, refs, commits, calls, filesAt };
}

describe("GitHub", () => {
  it("parses repository names", () => {
    expect(parseRepo("statewalker/cellb.dev")).toEqual({ owner: "statewalker", repo: "cellb.dev" });
    expect(parseRepo("https://github.com/a/b.git")).toEqual({ owner: "a", repo: "b" });
    expect(parseRepo("git@github.com:a/b.git")).toEqual({ owner: "a", repo: "b" });
    expect(() => parseRepo("nope")).toThrow();
  });

  it("computes git's blob ids", async () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(await gitBlobSha(encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("pushes a snapshot: changed files, deletions, nothing for unchanged files", async () => {
    const gh = fakeGitHub({ "README.md": "old", "gone.txt": "x", "node_modules/a.js": "kept" });
    const target = {
      owner: "o",
      repo: "r",
      branch: "main",
      token: "t",
      api: "http://gh",
      fetch: gh.fetchImpl,
    };
    const files = new Map([
      ["/README.md", encode("new")],
      ["/src/a.ts", encode("export {}")],
    ]);
    const r = await pushToGitHub(target, files, { message: "update", keep: ["node_modules"] });
    expect(r).toMatchObject({ changed: 2, deleted: 1, created: false });
    expect(gh.filesAt("main")).toEqual({
      "README.md": "new",
      "src/a.ts": "export {}",
      "node_modules/a.js": "kept",
    });

    const again = await pushToGitHub(target, files, { message: "noop", keep: ["node_modules"] });
    expect(again.unchanged).toBe(true);
    expect(gh.calls.filter((c) => c === "POST /git/blobs")).toHaveLength(2);
  });

  it("pushes to an empty repository and a new branch", async () => {
    const gh = fakeGitHub();
    const target = {
      owner: "o",
      repo: "r",
      branch: "main",
      token: "t",
      api: "http://gh",
      fetch: gh.fetchImpl,
    };
    const r = await pushToGitHub(target, new Map([["/a.txt", encode("a")]]), { message: "first" });
    expect(r.created).toBe(true);
    expect(gh.filesAt("main")).toEqual({ "a.txt": "a" });

    const d = await pushToGitHub(
      { ...target, branch: "deploy" },
      new Map([["/w.js", encode("w")]]),
      { message: "build" },
    );
    expect(d.created).toBe(true);
    expect(gh.filesAt("deploy")).toEqual({ "w.js": "w" });
    expect(gh.filesAt("main")).toEqual({ "a.txt": "a" });
  });

  it("pulls a branch's files", async () => {
    const gh = fakeGitHub({ "a.txt": "A", "node_modules/x.js": "x" });
    const { files } = await pullFromGitHub(
      { owner: "o", repo: "r", branch: "main", token: "t", api: "http://gh", fetch: gh.fetchImpl },
      (p) => p.startsWith("/node_modules/"),
    );
    expect([...files.keys()]).toEqual(["/a.txt"]);
    expect(decode(files.get("/a.txt") as Uint8Array)).toBe("A");
  });
});
