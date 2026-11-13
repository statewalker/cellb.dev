import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { openHistory } from "../src/sandbox/history";

const enc = (s: string) => new TextEncoder().encode(s);
async function text(fs: MemFilesApi, path: string) {
  let out = "";
  for await (const c of fs.read(path)) out += new TextDecoder().decode(c);
  return out;
}

describe("project history (git in the project's own FilesApi)", () => {
  it("commits, lists, reports changes, reopens, reads a file at a commit, restores", async () => {
    const fs = new MemFilesApi();
    await fs.write("/a.txt", [enc("one\n")]);
    await fs.write("/node_modules/x/index.js", [enc("x")]);
    // A project that is a git repository of its own: the sandbox's history leaves it alone.
    await fs.write("/.git/HEAD", [enc("ref: refs/heads/feature\n")]);
    let h = await openHistory(fs);
    expect(await fs.exists("/.gitignore")).toBe(false);
    const c1 = await h.commitAll("first");
    expect(c1?.message).toBe("first");
    expect(await h.commitAll("nothing changed")).toBeUndefined();

    await fs.write("/a.txt", [enc("two\n")]);
    await fs.write("/b.txt", [enc("b\n")]);
    expect(await h.changes()).toEqual({ added: ["b.txt"], changed: ["a.txt"], removed: [] });
    expect((await h.log())[0]?.message).toBe("first");

    h = await openHistory(fs); // as after a reload: the repository is in .git
    await h.commitAll("second");
    expect((await h.log()).map((c) => c.message)).toEqual(["second", "first"]);
    await fs.remove("/b.txt");
    expect((await h.changes()).removed).toEqual(["b.txt"]);
    expect(new TextDecoder().decode(await h.fileAt(c1?.id as string, "/a.txt"))).toBe("one\n");

    await h.restore(c1?.id as string);
    expect(await text(fs, "/a.txt")).toBe("one\n");
    expect(await fs.exists("/b.txt")).toBe(false);
    expect(await fs.exists("/node_modules/x/index.js")).toBe(true); // ignored: untouched
    // Loose objects and refs, as git keeps them.
    expect(await fs.exists("/.cellb/history/HEAD")).toBe(true);
    expect(await text(fs, "/.git/HEAD")).toBe("ref: refs/heads/feature\n");
    expect(await fs.exists("/.git/objects")).toBe(false);
  });
});
