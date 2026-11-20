// A thread that owns a FilesApi and answers a container's filesystem calls for it.
import { parentPort } from "node:worker_threads";
import { readText, writeText } from "@statewalker/webrun-files";
import { FilteredFilesApi, GuardedFilesApi, newPathFilter } from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { HostMounts, serveHostFiles } from "../../src/files/bridge.ts";

const files = new MemFilesApi();
const port = parentPort!;
port.on("message", async (msg: { type: string }) => {
  if (msg.type === "start") {
    await writeText(files, "/docs/a.txt", "hello from the host");
    await writeText(files, "/secret/key.txt", "s3cr3t");
    const mounts = new HostMounts();
    const id = mounts.add(
      new GuardedFilesApi(new FilteredFilesApi(files, newPathFilter("/secret")), [
        { operations: ["write", "remove", "move", "mkdir", "copy"], check: (p: string) => !p.startsWith("/docs"), message: "read-only" },
      ]),
    );
    const { port1, port2 } = new MessageChannel();
    serveHostFiles(port1, mounts);
    port.postMessage({ port: port2, id }, [port2 as never]);
  } else if (msg.type === "dump") {
    const out: Record<string, string> = {};
    for await (const e of files.list("/", { recursive: true }))
      if (e.kind === "file") out[e.path] = await readText(files, e.path);
    port.postMessage(out);
  }
});
