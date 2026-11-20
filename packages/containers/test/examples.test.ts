// The examples as cellb projects: each Durable Object starts its container and answers through it.
import { fileURLToPath } from "node:url";
import { loadProject } from "@statewalker/cellb/node";
import { Wasmer } from "@wasmer/sdk/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provideContainerEngine, wasmerContainerEngine } from "../src/index.ts";

const example = (name: string) => fileURLToPath(new URL(`../examples/${name}`, import.meta.url));
// wasmer/edgejs (Node-compatible JS in WASIX) needs WebAssembly JSPI: Node 24+ or Chromium 137+.
const hasJspi = typeof (WebAssembly as { Suspending?: unknown }).Suspending === "function";

let wasmer: Wasmer;
let withdraw: () => Promise<void>;
beforeAll(() => {
  wasmer = new Wasmer({ cache: { directory: ".wasmer" } });
  withdraw = provideContainerEngine(wasmerContainerEngine(wasmer));
});
afterAll(async () => {
  await withdraw?.();
  await wasmer?.close();
});

async function run(name: string, paths: string[]) {
  const project = await loadProject(example(name));
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
});
