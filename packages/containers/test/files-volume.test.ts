// FilesVolume: Wasmer's host-filesystem protocol (the calls a WASIX guest makes on a mounted
// directory) served by any FilesApi. No Wasmer here: the protocol is called directly.
import { readText, writeText } from "@statewalker/webrun-files";
import {
  FilteredFilesApi,
  GuardedFilesApi,
  newPathFilter,
  readOnly,
} from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { FilesVolume } from "../src/files/volume.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "no error";
};

describe("FilesVolume", () => {
  let files: MemFilesApi;
  let volume: FilesVolume;
  beforeEach(async () => {
    files = new MemFilesApi();
    await writeText(files, "/docs/a.txt", "hello world");
    await files.mkdir("/empty");
    volume = new FilesVolume(files);
  });

  it("stats the root, a directory and a file", async () => {
    expect(await volume.request("stat", [""])).toMatchObject({ kind: "directory" });
    expect(await volume.request("stat", ["docs"])).toMatchObject({ kind: "directory" });
    expect(await volume.request("stat", ["docs/a.txt"])).toMatchObject({ kind: "file", size: 11 });
  });

  it("reports times as decimal nanosecond strings", async () => {
    const st = (await volume.request("stat", ["docs/a.txt"])) as { modified: string };
    expect(st.modified).toMatch(/^\d+$/);
    expect(BigInt(st.modified)).toBeGreaterThan(10n ** 18n);
  });

  it("lists a directory with names relative to it", async () => {
    const entries = (await volume.request("readDir", [""])) as { name: string; kind: string }[];
    expect(entries.map((e) => [e.name, e.kind]).sort()).toEqual([
      ["docs", "directory"],
      ["empty", "directory"],
    ]);
    expect(await volume.request("readDir", ["docs"])).toEqual([
      expect.objectContaining({ name: "a.txt", kind: "file", size: 11 }),
    ]);
  });

  it("returns POSIX codes for missing paths and wrong kinds", async () => {
    expect(await code(volume.request("stat", ["nope"]))).toBe("ENOENT");
    expect(await code(volume.request("readDir", ["docs/a.txt"]))).toBe("ENOTDIR");
    expect(
      await code(volume.request("open", ["docs", true, false, false, false, false, false])),
    ).toBe("EISDIR");
    expect(await code(volume.request("mkdir", ["docs"]))).toBe("EEXIST");
  });

  it("rejects paths that escape the volume or are absolute", async () => {
    expect(await code(volume.request("stat", ["../etc/passwd"]))).toBe("EACCES");
    expect(await code(volume.request("stat", ["docs/../../x"]))).toBe("EACCES");
    expect(await code(volume.request("stat", ["/docs"]))).toBe("EINVAL");
  });

  it("reads byte ranges through a descriptor", async () => {
    const fd = await volume.request("open", [
      "docs/a.txt",
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    const bytes = (await volume.request("read", [fd, 6, 100])) as Uint8Array;
    expect(dec.decode(bytes)).toBe("world");
    expect(await volume.request("fileStat", [fd])).toMatchObject({ kind: "file", size: 11 });
    await volume.request("close", [fd]);
    expect(await code(volume.request("read", [fd, 0, 1]))).toBe("EBADF");
  });

  it("creates, writes and flushes a file back to the FilesApi on close", async () => {
    const fd = await volume.request("open", ["new.txt", false, true, true, false, true, false]);
    expect(await volume.request("write", [fd, 0, enc.encode("abc")])).toBe(3);
    expect(await volume.request("write", [fd, 3, enc.encode("def")])).toBe(3);
    await volume.request("close", [fd]);
    expect(await readText(files, "/new.txt")).toBe("abcdef");
  });

  it("supports append, truncate and setLen", async () => {
    let fd = await volume.request("open", ["docs/a.txt", false, true, false, false, false, true]);
    await volume.request("write", [fd, 0, enc.encode("!")]);
    await volume.request("close", [fd]);
    expect(await readText(files, "/docs/a.txt")).toBe("hello world!");
    fd = await volume.request("open", ["docs/a.txt", true, true, false, false, false, false]);
    await volume.request("setLen", [fd, 5]);
    await volume.request("flush", [fd]);
    expect(await readText(files, "/docs/a.txt")).toBe("hello");
    await volume.request("close", [fd]);
    fd = await volume.request("open", ["docs/a.txt", false, true, false, false, true, false]);
    await volume.request("close", [fd]);
    expect(await readText(files, "/docs/a.txt")).toBe("");
  });

  it("refuses create_new on an existing file and open without create on a missing one", async () => {
    expect(
      await code(volume.request("open", ["docs/a.txt", false, true, false, true, false, false])),
    ).toBe("EEXIST");
    expect(
      await code(volume.request("open", ["missing.txt", true, false, false, false, false, false])),
    ).toBe("ENOENT");
  });

  it("makes, renames and removes entries", async () => {
    await volume.request("mkdir", ["out"]);
    await volume.request("rename", ["docs/a.txt", "out/b.txt"]);
    expect(await files.exists("/docs/a.txt")).toBe(false);
    expect(await readText(files, "/out/b.txt")).toBe("hello world");
    expect(await code(volume.request("remove", ["out"]))).toBe("ENOTEMPTY");
    await volume.request("remove", ["out/b.txt"]);
    await volume.request("remove", ["out"]);
    expect(await files.exists("/out")).toBe(false);
  });

  it("accepts setTimes, setFileTimes and sync as no-ops", async () => {
    await expect(volume.request("setTimes", ["docs/a.txt", null, "1"])).resolves.toBeNull();
    await expect(volume.request("sync", [])).resolves.toBeNull();
  });

  it("is read-only when asked: every mutation fails with EACCES", async () => {
    const ro = new FilesVolume(files, { readOnly: true });
    expect(await code(ro.request("open", ["x.txt", false, true, true, false, false, false]))).toBe(
      "EACCES",
    );
    expect(await code(ro.request("mkdir", ["d"]))).toBe("EACCES");
    expect(await code(ro.request("remove", ["docs/a.txt"]))).toBe("EACCES");
    expect(await ro.request("stat", ["docs/a.txt"])).toMatchObject({ kind: "file" });
  });

  it("maps composite guards to EACCES and filtered paths to ENOENT", async () => {
    await writeText(files, "/secret/key.txt", "s3cr3t");
    const guarded = new GuardedFilesApi(new FilteredFilesApi(files, newPathFilter("/secret")), [
      {
        operations: ["write", "remove", "move", "mkdir", "copy"],
        check: (path: string) => !path.startsWith("/docs"),
        message: "docs are read-only",
      },
    ]);
    const v = new FilesVolume(guarded);
    expect(await code(v.request("stat", ["secret/key.txt"]))).toBe("ENOENT");
    expect((await v.request("readDir", [""])) as { name: string }[]).not.toContainEqual(
      expect.objectContaining({ name: "secret" }),
    );
    // A write the FilesApi refuses fails at open(), where the guest checks for errors.
    expect(
      await code(v.request("open", ["docs/a.txt", false, true, false, false, true, false])),
    ).toBe("EACCES");
    expect(await readText(files, "/docs/a.txt")).toBe("hello world");
    // create puts the file in the FilesApi at open(), as POSIX O_CREAT does
    const fd = await v.request("open", ["made.txt", false, true, true, false, false, false]);
    expect(await files.exists("/made.txt")).toBe(true);
    await v.request("close", [fd]);
    const rov = new FilesVolume(readOnly(files));
    expect(await code(rov.request("mkdir", ["z"]))).toBe("EACCES");
  });

  it("caps a read at the bridge's 64 KiB chunk", async () => {
    await files.write("/big.bin", [new Uint8Array(200_000)]);
    const fd = await volume.request("open", ["big.bin", true, false, false, false, false, false]);
    expect(((await volume.request("read", [fd, 0, 200_000])) as Uint8Array).length).toBe(65_536);
  });
});
