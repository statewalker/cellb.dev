// The history pushed to a real git server over smart HTTP (git http-backend), then read by git.
import assert from "node:assert/strict";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { openHistory } from "../src/sandbox/history";
import { startGitServer } from "./git-server.mjs";

const enc = (s: string) => new TextEncoder().encode(s);
const srv = await startGitServer();
try {
  const url = srv.create("demo.git");
  const fs = new MemFilesApi();
  await fs.write("/README.md", [enc("# demo\n")]);
  await fs.write("/server/index.ts", [enc("export default {}\n")]);
  const h = await openHistory(fs);
  await h.commitAll("first");
  const p1 = await h.push(url);
  assert.ok(p1.ok, JSON.stringify(p1));
  await fs.write("/README.md", [enc("# demo, again\n")]);
  await h.commitAll("second");
  const p2 = await h.push(url);
  assert.ok(p2.ok, JSON.stringify(p2));
  const log = srv.git("demo.git", "log", "--format=%s", "main");
  assert.deepEqual(log.trim().split("\n"), ["second", "first"]);
  assert.equal(srv.git("demo.git", "show", "main:README.md"), "# demo, again\n");
  srv.git("demo.git", "fsck", "--strict");
  console.log("history-push: all good (git log:", log.trim().split("\n").join(", "), ")");
} finally {
  await srv.close();
}
