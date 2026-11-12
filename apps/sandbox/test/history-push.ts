// The history and a real git server over smart HTTP (git http-backend): push, then a commit made
// elsewhere (with git) pulled back; branches made, switched, pushed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { openHistory } from "../src/sandbox/history";
import { startGitServer } from "./git-server.mjs";

const enc = (s: string) => new TextEncoder().encode(s);
async function text(fs: MemFilesApi, path: string) {
  let out = "";
  for await (const c of fs.read(path)) out += new TextDecoder().decode(c);
  return out;
}
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Other", "-c", "user.email=o@x", ...args], {
    cwd,
    encoding: "utf8",
  });

const srv = await startGitServer();
try {
  const url = srv.create("demo.git");
  const fs = new MemFilesApi();
  await fs.write("/README.md", [enc("# demo\n")]);
  await fs.write("/server/index.ts", [enc("export default {}\n")]);
  const h = await openHistory(fs);
  await h.commitAll("first");
  assert.ok((await h.push(url)).ok);
  await fs.write("/README.md", [enc("# demo, again\n")]);
  await h.commitAll("second");
  assert.ok((await h.push(url)).ok);
  assert.deepEqual(srv.git("demo.git", "log", "--format=%s", "main").trim().split("\n"), [
    "second",
    "first",
  ]);
  assert.equal(srv.git("demo.git", "show", "main:README.md"), "# demo, again\n");
  srv.git("demo.git", "fsck", "--strict");
  console.log("• push: git log and fsck on the server");

  // Someone else commits (with git), the history pulls it: a fast-forward, files updated.
  const clone = await mkdtemp(join(tmpdir(), "other-"));
  // Through the bare repository's path: a synchronous `git clone http://…` would block the
  // event loop the server in this process answers on.
  sh(clone, "clone", "-q", join(srv.root, "demo.git"), ".");
  await writeFile(join(clone, "NOTES.md"), "from elsewhere\n");
  await writeFile(join(clone, "README.md"), "# demo, edited elsewhere\n");
  sh(clone, "add", ".");
  sh(clone, "commit", "-q", "-m", "elsewhere");
  sh(clone, "push", "-q", "origin", "main");
  const pulled = await h.pull(url);
  assert.ok(pulled.ok, JSON.stringify(pulled));
  assert.equal(await text(fs, "/NOTES.md"), "from elsewhere\n");
  assert.equal(await text(fs, "/README.md"), "# demo, edited elsewhere\n");
  assert.equal((await h.log())[0]?.message, "elsewhere");
  console.log("• pull: a commit made with git, fast-forwarded into the project's files");

  // Branches: made at the current commit, switched (files follow), pushed, read by git.
  await h.createBranch("feature");
  await fs.write("/feature.txt", [enc("on feature\n")]);
  await h.commitAll("feature work");
  assert.deepEqual((await h.branches()).all, ["feature", "main"]);
  assert.equal((await h.branches()).current, "feature");
  assert.ok((await h.push(url, { branch: "feature" })).ok);
  assert.equal(srv.git("demo.git", "log", "-1", "--format=%s", "feature").trim(), "feature work");
  await h.switchBranch("main");
  assert.equal(await fs.exists("/feature.txt"), false);
  await h.switchBranch("feature");
  assert.equal(await text(fs, "/feature.txt"), "on feature\n");
  sh(clone, "fetch", "-q", "origin");
  assert.equal(await readFile(join(clone, "README.md"), "utf8"), "# demo, edited elsewhere\n");
  console.log("• branches: created, switched (files follow), pushed");
  console.log("history-push: all good");
} finally {
  await srv.close();
}
