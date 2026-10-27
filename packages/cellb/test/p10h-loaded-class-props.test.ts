import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { projectDir } from "../conformance/projects.js";
import { loadNodeProject, nodeSqliteOpener } from "../src/node.js";

// getDurableObjectClass(name, { props }) for a class loaded into the project's realm: the
// conformance scenario `worker-loader-props` runs it in an isolate; both answer as workerd.
describe("P10h props of a loaded Durable Object class", () => {
  it("reach the facet's ctx.props when the class runs in the project's realm", async () => {
    const { transcript } = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../conformance/golden-workerd/worker-loader-props.json"),
        "utf8",
      ),
    );
    const { runtime } = await loadNodeProject(projectDir("worker-loader-props"), {
      openSql: nodeSqliteOpener(),
      files: new MemFilesApi(),
      isolatedModules: undefined,
    });
    try {
      const res = await runtime.fetch(new Request("http://w/"));
      expect(await res.json()).toEqual(transcript[0].body);
    } finally {
      await runtime.close();
    }
  });
});
