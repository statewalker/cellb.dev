import { DurableObject } from "cloudflare:workers";
import { containerPool } from "@statewalker/cellb-containers/pool";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

// One workspace per cell: its own files, and custom code run against them in a container of the
// host's pool. Each run gets a fresh sandbox that sees only this cell's files at /data.
export class Workspace extends DurableObject {
  // This cell's files: in memory while the object lives (any FilesApi works, a durable one too).
  files = new MemFilesApi();

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/run" && request.method === "POST") {
      const result = await containerPool("python").run({
        argv: ["python", "-c", await request.text()],
        files: this.files,
        env: { CELL: this.ctx.id.name },
        timeoutMs: 10_000,
      });
      return Response.json(result);
    }
    if (url.pathname === "/files") {
      const names = [];
      for await (const entry of this.files.list("/", { recursive: true })) names.push(entry.path);
      return Response.json(names.sort());
    }
    return new Response("POST /run with Python code, or GET /files", { status: 404 });
  }
}

export default {
  fetch(request, env) {
    const name = new URL(request.url).searchParams.get("cell") ?? "alpha";
    return env.WORKSPACE.get(env.WORKSPACE.idFromName(name)).fetch(request);
  },
};
