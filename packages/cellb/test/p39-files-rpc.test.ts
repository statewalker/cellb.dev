import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterEach, describe, expect, it } from "vitest";
import { rpcFilesClient, serveFilesApi } from "../src/ltx/files-rpc.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const text = async (it: AsyncIterable<Uint8Array>) => {
  let s = "";
  for await (const c of it) s += dec.decode(c, { stream: true });
  return s;
};

const channels: MessageChannel[] = [];
afterEach(() => {
  for (const c of channels.splice(0)) c.port1.close(), c.port2.close();
});
function remote(files = new MemFilesApi()) {
  const ch = new MessageChannel();
  channels.push(ch);
  serveFilesApi(ch.port1, files);
  return { files, client: rpcFilesClient(ch.port2, { batchBytes: 8 }) };
}

describe("FilesApi over a MessagePort (files-rpc)", () => {
  it("writes in batches, reads whole and by range, stats, lists, moves and removes", async () => {
    const { files, client } = remote();
    await client.write(
      "/a/b.txt",
      (async function* () {
        for (const s of ["hello", " ", "remote", " ", "world"]) yield enc.encode(s);
      })(),
    );
    expect(await text(files.read("/a/b.txt"))).toBe("hello remote world");
    expect(await text(client.read("/a/b.txt"))).toBe("hello remote world");
    expect(await text(client.read("/a/b.txt", { start: 6, length: 6 }))).toBe("remote");
    expect(await text(client.read("/a/b.txt", { start: 13 }))).toBe("world");
    expect(await client.stats("/a/b.txt")).toMatchObject({ kind: "file", size: 18 });
    expect(await client.stats("/nope")).toBeUndefined();
    expect(await client.exists("/a")).toBe(true);
    await client.write("/a/c.txt", [enc.encode("c")]);
    const names: string[] = [];
    for await (const e of client.list("/a")) names.push(e.path);
    expect(names).toEqual(["/a/b.txt", "/a/c.txt"]);
    const after: string[] = [];
    for await (const e of client.list("/a", { after: "/a/b.txt" })) after.push(e.path);
    expect(after).toEqual(["/a/c.txt"]);
    expect(await client.move("/a/c.txt", "/a/d.txt")).toBe(true);
    expect(await files.exists("/a/c.txt")).toBe(false);
    expect(await text(files.read("/a/d.txt"))).toBe("c");
    expect(await client.copy("/a/d.txt", "/e.txt")).toBe(true);
    expect(await client.remove("/a")).toBe(true);
    expect(await files.exists("/a/b.txt")).toBe(false);
    expect(await text(client.read("/missing"))).toBe("");
    expect(await text(client.read("/missing", { start: 0, length: 4 }))).toBe("");
  });

  it("carries a large write and read intact", async () => {
    const { files, client } = remote();
    const big = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => (i * 31) & 255);
    const ch = new MessageChannel();
    channels.push(ch);
    serveFilesApi(ch.port1, files);
    const c2 = rpcFilesClient(ch.port2); // default batches (1 MiB)
    await c2.write(
      "/big.bin",
      (function* () {
        for (let o = 0; o < big.length; o += 4096) yield big.subarray(o, o + 4096);
      })(),
    );
    const back: Uint8Array[] = [];
    for await (const c of client.read("/big.bin")) back.push(c);
    const all = new Uint8Array(back.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of back) all.set(c, o), (o += c.length);
    expect(all.length).toBe(big.length);
    expect(Buffer.from(all).equals(Buffer.from(big))).toBe(true); // toEqual walks 3 M elements
  });

  it("rejects with the serving side's error", async () => {
    const failing = Object.assign(new MemFilesApi(), {
      async stats(): Promise<never> {
        throw new Error("disk is gone");
      },
    });
    const { client } = remote(failing);
    await expect(client.stats("/x")).rejects.toThrow("disk is gone");
  });
});
