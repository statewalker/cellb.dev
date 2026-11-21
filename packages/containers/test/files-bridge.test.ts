// A FilesApi mounted into a WASIX container, with the composite decorators as the security
// boundary: hidden paths do not exist for the guest, guarded paths refuse writes.
// The FilesApi is served either on the Wasmer client's thread or by another thread that owns it
// (the request carries a SharedArrayBuffer; whoever holds it can answer).
import { Worker } from "node:worker_threads";
import { readText, writeText } from "@statewalker/webrun-files";
import {
  FilteredFilesApi,
  GuardedFilesApi,
  newPathFilter,
} from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { Wasmer } from "@wasmer/sdk/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forwardHostFiles, HostMounts, installHostFiles } from "../src/files/bridge.ts";

const GUEST = `
import json, os
r = {}
r["list"] = sorted(os.listdir("/data"))
r["read"] = open("/data/docs/a.txt").read()
r["secretVisible"] = os.path.exists("/data/secret/key.txt")
try:
    open("/data/docs/a.txt", "w").write("X")
    r["docsWrite"] = "ok"
except Exception as e:
    r["docsWrite"] = type(e).__name__
os.makedirs("/data/out", exist_ok=True)
with open("/data/out/new.txt", "w") as f:
    f.write("written by python " * 5000)
r["size"] = os.path.getsize("/data/out/new.txt")
os.rename("/data/out/new.txt", "/data/out/renamed.txt")
print(json.dumps(r))
`;

/** The FilesApi a container gets: /secret hidden, /docs read-only. */
export function sandboxedFiles(files: MemFilesApi) {
  return new GuardedFilesApi(new FilteredFilesApi(files, newPathFilter("/secret")), [
    {
      operations: ["write", "remove", "move", "mkdir", "copy"],
      check: (p: string) => !p.startsWith("/docs"),
      message: "read-only",
    },
  ]);
}

async function seed(files: MemFilesApi) {
  await writeText(files, "/docs/a.txt", "hello from the host");
  await writeText(files, "/secret/key.txt", "s3cr3t");
}

const EXPECTED = {
  list: ["docs"],
  read: "hello from the host",
  secretVisible: false,
  docsWrite: "PermissionError",
  size: 18 * 5000,
};

let wasmer: Wasmer;
beforeAll(() => {
  wasmer = new Wasmer({ cache: { directory: ".wasmer" } });
});
afterAll(async () => {
  await wasmer.close();
});

async function runGuest(mountId: number) {
  const sb = await wasmer.sandboxes.create({
    packages: ["python/python"],
    mounts: [{ path: "/data", id: mountId }],
  } as never);
  try {
    const out = await sb.command("python", ["-c", GUEST]).run({ check: false });
    expect(out.stderr.text()).toBe("");
    return JSON.parse(out.stdout.text());
  } finally {
    await sb.close();
  }
}

describe("FilesApi mounts in a container", () => {
  it("served on the client's own thread", async () => {
    const files = new MemFilesApi();
    await seed(files);
    const mounts = new HostMounts();
    const id = mounts.add(sandboxedFiles(files));
    const uninstall = installHostFiles(mounts);
    try {
      expect(await runGuest(id)).toEqual(EXPECTED);
      expect(await files.exists("/out/new.txt")).toBe(false);
      expect((await readText(files, "/out/renamed.txt")).length).toBe(18 * 5000);
      expect(await readText(files, "/docs/a.txt")).toBe("hello from the host");
    } finally {
      uninstall();
    }
  });

  it("served by another thread that owns the FilesApi", async () => {
    const worker = new Worker(new URL("./fixtures/files-worker.ts", import.meta.url));
    const ask = (msg: object) =>
      new Promise<any>((resolve) => {
        worker.once("message", resolve);
        worker.postMessage(msg);
      });
    try {
      const { port, id } = await ask({ type: "start" });
      const uninstall = installHostFiles(forwardHostFiles(port));
      try {
        expect(await runGuest(id)).toEqual(EXPECTED);
        const dump = await ask({ type: "dump" });
        expect(dump["/out/renamed.txt"]?.length).toBe(18 * 5000);
        expect(dump["/docs/a.txt"]).toBe("hello from the host");
      } finally {
        uninstall();
      }
    } finally {
      await worker.terminate();
    }
  });

  it("answers ENOENT for a mount id nobody registered", async () => {
    const uninstall = installHostFiles(new HostMounts());
    try {
      const sb = await wasmer.sandboxes.create({
        packages: ["python/python"],
        mounts: [{ path: "/data", id: 999 }],
      } as never);
      const out = await sb
        .command("python", ["-c", "import os; print(os.path.exists('/data/x'))"])
        .run({ check: false });
      expect(out.stdout.text().trim()).toBe("False");
      await sb.close();
    } finally {
      uninstall();
    }
  });
});

describe("serveHostFiles: a port answers only the mounts it is allowed", () => {
  it("a request for another mount id is refused", async () => {
    const { MessageChannel, Worker } = await import("node:worker_threads");
    const { HostMounts, serveHostFiles } = await import("../src/files/bridge.ts");
    const { MemFilesApi } = await import("@statewalker/webrun-files-mem");
    const { writeText } = await import("@statewalker/webrun-files");
    const mine = new MemFilesApi();
    const theirs = new MemFilesApi();
    await writeText(mine, "/mine.txt", "a");
    await writeText(theirs, "/theirs.txt", "b");
    const mounts = new HostMounts();
    const a = mounts.add(mine);
    const b = mounts.add(theirs);
    const channel = new MessageChannel();
    serveHostFiles(channel.port1 as never, mounts, { allow: (id) => id === a });
    const worker = new Worker(new URL("./fixtures/files-probe-worker.ts", import.meta.url), {
      workerData: { port: channel.port2, ids: [a, b] },
      transferList: [channel.port2],
    });
    const results = await new Promise((resolve) => worker.once("message", resolve));
    await worker.terminate();
    channel.port1.close();
    expect(results).toEqual([
      { id: a, names: ["mine.txt"] },
      { id: b, error: "EACCES" },
    ]);
  });
});
