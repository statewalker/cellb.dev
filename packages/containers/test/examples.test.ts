// The examples as cellb projects: each Durable Object starts its container and answers through it.
import { fileURLToPath } from "node:url";
import { loadProject } from "@statewalker/cellb/node";
import { Wasmer } from "@wasmer/sdk/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ContainerEngine,
  createContainerPool,
  HostMounts,
  installHostFiles,
  provideContainerPool,
  wasmerContainerEngine,
} from "../src/index.ts";

const example = (name: string) => fileURLToPath(new URL(`../examples/${name}`, import.meta.url));
// wasmer/edgejs (Node-compatible JS in WASIX) needs WebAssembly JSPI: Node 24+ or Chromium 137+.
const hasJspi = typeof (WebAssembly as { Suspending?: unknown }).Suspending === "function";

let wasmer: Wasmer;
let engine: ContainerEngine;
beforeAll(() => {
  wasmer = new Wasmer({ cache: { directory: ".wasmer" } });
  engine = wasmerContainerEngine(wasmer);
});
afterAll(async () => {
  await engine?.close();
  await wasmer?.close();
});

async function run(name: string, paths: string[]) {
  const project = await loadProject(example(name), { containers: engine });
  expect(project.unsupported).toEqual([]);
  try {
    const out = [];
    for (const p of paths) {
      const res = await project.fetch(new Request(`http://localhost${p}`));
      out.push({ status: res.status, body: await res.json() });
    }
    return out;
  } finally {
    await project.close();
  }
}

describe("examples", () => {
  it("php: PHP's built-in server answers from the container", async () => {
    const [a, b] = await run("php", ["/?cell=alpha", "/info?cell=alpha"]);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({
      cell: "alpha",
      visits: 1,
      fromContainer: { php: expect.stringMatching(/^8\./), uri: "/?cell=alpha" },
    });
    expect(b.body).toMatchObject({ visits: 2, fromContainer: { uri: "/info?cell=alpha" } });
  });

  it.skipIf(!hasJspi)(
    "node: a node:http server in wasmer/edgejs answers from the container",
    async () => {
      const [a] = await run("node", ["/hello?cell=alpha"]);
      expect(a.status).toBe(200);
      expect(a.body).toMatchObject({
        cell: "alpha",
        fromContainer: { node: expect.stringMatching(/^v\d+/), url: "/hello?cell=alpha" },
      });
    },
  );

  it("files: a host FilesApi, filtered and guarded, mounted for a Python analysis", async () => {
    const { runFilesExample } = await import("../examples/files/run.mjs");
    const r = await runFilesExample(wasmer);
    expect(r.report).toMatchObject({
      files: 2,
      words: 9,
      hiddenSeen: false,
      writeToInput: "PermissionError",
    });
    expect(r.hostOutput).toContain("words: 9");
  });

  it("pool: each cell runs its own code on its own FilesApi; nothing leaks between cells", async () => {
    const mounts = new HostMounts();
    const uninstall = installHostFiles(mounts);
    const pool = createContainerPool(wasmerContainerEngine(wasmer), mounts, {
      image: { packages: ["python/python"] },
      size: 2,
    });
    const unprovide = provideContainerPool("python", pool);
    const project = await loadProject(example("pool"));
    const run = async (cell: string, code: string) =>
      (
        await project.fetch(
          new Request(`http://localhost/run?cell=${cell}`, { method: "POST", body: code }),
        )
      ).json();
    const files = async (cell: string) =>
      (await project.fetch(new Request(`http://localhost/files?cell=${cell}`))).json();
    try {
      const a1 = await run(
        "alpha",
        "import os\nopen('/data/note.txt','w').write('alpha was here')\nopen('/workspace/scratch','w').write('x')\nprint(os.environ['CELL'])",
      );
      expect(a1).toMatchObject({ exitCode: 0, stdout: "alpha\n" });
      const b1 = await run(
        "beta",
        "import os, json\nprint(json.dumps([sorted(os.listdir('/data')), os.path.exists('/workspace/scratch')]))",
      );
      expect(JSON.parse(b1.stdout)).toEqual([[], false]);
      const a2 = await run("alpha", "print(open('/data/note.txt').read())");
      expect(a2.stdout).toBe("alpha was here\n");
      expect(await files("alpha")).toEqual(["/note.txt"]);
      expect(await files("beta")).toEqual([]);
    } finally {
      await project.close();
      unprovide();
      await pool.close();
      uninstall();
    }
  });
});
