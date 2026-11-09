import { readFile, readText, writeText } from "@statewalker/webrun-files";
import { describe, expect, it } from "vitest";
import { BLOCK_SIZE, SqlFilesApi } from "../src/sql-files.js";
import { subtree } from "../src/util.js";
import { nodeSqlStorage } from "./sql-storage.js";

const list = async (files: SqlFilesApi, dir: string, recursive = false) => {
  const out: string[] = [];
  for await (const e of files.list(dir, { recursive }))
    out.push(`${e.kind === "file" ? "f" : "d"}:${e.path}`);
  return out;
};

describe("SqlFilesApi", () => {
  it("writes and reads files across blocks, with ranges", async () => {
    const files = new SqlFilesApi(nodeSqlStorage(), "t");
    const big = new Uint8Array(BLOCK_SIZE * 2 + 123).map((_, i) => i % 251);
    await files.write("/a/big.bin", [big.subarray(0, 1000), big.subarray(1000)]);
    expect(await readFile(files, "/a/big.bin")).toEqual(big);
    const part: Uint8Array[] = [];
    for await (const c of files.read("/a/big.bin", { start: BLOCK_SIZE - 10, length: 20 }))
      part.push(c);
    expect(Buffer.concat(part)).toEqual(
      Buffer.from(big.subarray(BLOCK_SIZE - 10, BLOCK_SIZE + 10)),
    );
    expect(await files.stats("/a/big.bin")).toMatchObject({ kind: "file", size: big.length });
  });

  it("lists in path order, implicit and explicit directories", async () => {
    const files = new SqlFilesApi(nodeSqlStorage(), "t");
    await writeText(files, "/b/x.txt", "x");
    await writeText(files, "/a/y/z.txt", "z");
    await writeText(files, "/a/w.txt", "w");
    await files.mkdir("/c/empty");
    expect(await list(files, "/")).toEqual(["d:/a", "d:/b", "d:/c"]);
    expect(await list(files, "/a", true)).toEqual(["f:/a/w.txt", "d:/a/y", "f:/a/y/z.txt"]);
    expect(await files.stats("/a/y")).toEqual({ kind: "directory" });
    expect(await files.exists("/c/empty")).toBe(true);
    expect(await files.exists("/nope")).toBe(false);
  });

  it("does not confuse a directory with a sibling sharing its prefix", async () => {
    const files = new SqlFilesApi(nodeSqlStorage(), "t");
    await writeText(files, "/ab/1", "1");
    await writeText(files, "/a/2", "2");
    await writeText(files, "/a0", "0");
    expect(await list(files, "/a", true)).toEqual(["f:/a/2"]);
    await files.remove("/a");
    expect(await files.exists("/ab/1")).toBe(true);
    expect(await files.exists("/a0")).toBe(true);
  });

  it("copies, moves and removes trees", async () => {
    const files = new SqlFilesApi(nodeSqlStorage(), "t");
    await writeText(files, "/src/a.txt", "a");
    await writeText(files, "/src/d/b.txt", "b");
    await files.copy("/src", "/copy");
    await files.move("/src", "/moved");
    expect(await readText(files, "/copy/d/b.txt")).toBe("b");
    expect(await readText(files, "/moved/a.txt")).toBe("a");
    expect(await files.exists("/src")).toBe(false);
    expect(await files.remove("/copy")).toBe(true);
    expect(files.filePaths("/")).toEqual(["/moved/a.txt", "/moved/d/b.txt"]);
  });

  it("serves a subtree as a FilesApi of its own", async () => {
    const files = new SqlFilesApi(nodeSqlStorage(), "t");
    await writeText(files, "/snap/1/index.html", "<p>");
    const view = subtree(files, "/snap/1");
    expect(await readText(view, "/index.html")).toBe("<p>");
    const names: string[] = [];
    for await (const e of view.list("/")) names.push(e.path);
    expect(names).toEqual(["/index.html"]);
  });
});
