import { describe, expect, it } from "vitest";
import { treeRows } from "../src/components/FileTree";
import { encode } from "../src/sandbox/project";
import {
  addDir,
  addFile,
  allDirs,
  checkPath,
  EditError,
  intoDir,
  move,
  remove,
  type Workspace,
  writeFile,
} from "../src/sandbox/workspace";

const ws = (paths: string[], dirs: string[] = []): Workspace => ({
  files: new Map(paths.map((p) => [p, encode(p)])),
  dirs: new Set(dirs),
});
const keys = (w: Workspace) => [...w.files.keys()].sort();

describe("workspace edits", () => {
  const base = ws([
    "/wrangler.jsonc",
    "/server/index.ts",
    "/client/index.html",
    "/client/src/main.tsx",
  ]);

  it("checks typed paths", () => {
    expect(checkPath(" client/src/new.ts ")).toBe("/client/src/new.ts");
    expect(checkPath("/a//b/./c")).toBe("/a/b/c");
    for (const bad of ["", "/", "../x", "a/../../b", "a:b", "a*b"])
      expect(() => checkPath(bad), bad).toThrow(EditError);
  });

  it("adds files and folders, refusing taken names and files as parents", () => {
    const a = addFile(base, "/client/src/api.ts", encode("x"));
    expect(keys(a)).toContain("/client/src/api.ts");
    expect(() => addFile(a, "/client/src/api.ts")).toThrow("already exists");
    expect(() => addFile(a, "/client")).toThrow("already a folder");
    expect(() => addFile(a, "/wrangler.jsonc/x.ts")).toThrow("is a file");
    const d = addDir(a, "/client/assets");
    expect(allDirs(d).has("/client/assets")).toBe(true);
    // The empty folder is dropped from `dirs` once a file is in it.
    const f = addFile(d, "/client/assets/logo.svg");
    expect(f.dirs.has("/client/assets")).toBe(false);
    expect(allDirs(f).has("/client/assets")).toBe(true);
  });

  it("writes a file's bytes", () => {
    const w = writeFile(base, "/server/index.ts", encode("export default {}"));
    expect(new TextDecoder().decode(w.files.get("/server/index.ts"))).toBe("export default {}");
    expect(() => writeFile(base, "/nope.ts", encode(""))).toThrow("does not exist");
  });

  it("removes a file, or a folder with everything below it", () => {
    const f = remove(base, "/server/index.ts");
    expect(f.removed).toEqual(["/server/index.ts"]);
    const d = remove(base, "/client");
    expect(d.removed.sort()).toEqual(["/client/index.html", "/client/src/main.tsx"]);
    expect(keys(d.ws)).toEqual(["/server/index.ts", "/wrangler.jsonc"]);
    const empty = remove(addDir(base, "/tmp"), "/tmp");
    expect(allDirs(empty.ws).has("/tmp")).toBe(false);
    expect(() => remove(base, "/nope")).toThrow("does not exist");
  });

  it("renames and moves files and folders, reporting each move", () => {
    const r = move(base, "/server/index.ts", "/server/main.ts");
    expect(keys(r.ws)).toContain("/server/main.ts");
    expect([...r.moved]).toEqual([["/server/index.ts", "/server/main.ts"]]);
    const d = move(base, "/client", "/web");
    expect(keys(d.ws)).toEqual([
      "/server/index.ts",
      "/web/index.html",
      "/web/src/main.tsx",
      "/wrangler.jsonc",
    ]);
    expect(d.moved.get("/client/src/main.tsx")).toBe("/web/src/main.tsx");
    // Bytes travel with the file.
    expect(new TextDecoder().decode(d.ws.files.get("/web/index.html"))).toBe("/client/index.html");
    expect(() => move(base, "/client", "/client/src/inner")).toThrow("into itself");
    expect(() => move(base, "/server/index.ts", "/wrangler.jsonc")).toThrow("already exists");
    // A folder named like a prefix of another is not moved with it.
    const p = move(ws(["/a/x", "/ab/y"]), "/a", "/c");
    expect(keys(p.ws)).toEqual(["/ab/y", "/c/x"]);
  });

  it("moves an empty folder", () => {
    const m = move(addDir(base, "/client/assets"), "/client/assets", "/assets");
    expect(allDirs(m.ws).has("/assets")).toBe(true);
    expect(allDirs(m.ws).has("/client/assets")).toBe(false);
  });

  it("drops a path into a folder", () => {
    expect(intoDir("/server", "/client/src/main.tsx")).toBe("/server/main.tsx");
    expect(intoDir("/", "/client/src")).toBe("/src");
  });

  it("lists folders before files, empty folders included", () => {
    const w = addDir(base, "/client/assets");
    expect(treeRows([...w.files.keys()], allDirs(w)).map((r) => `${r.depth}:${r.name}`)).toEqual([
      "0:client",
      "1:assets",
      "1:src",
      "2:main.tsx",
      "1:index.html",
      "0:server",
      "1:index.ts",
      "0:wrangler.jsonc",
    ]);
  });
});
