import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { projectDir } from "../conformance/projects.js";
import { goldenDir, LOADED_IN_REALM, scenarios } from "../conformance/scenarios.js";
import { loadNodeProject, nodeSqliteOpener } from "../src/node.js";

// Conformance scenarios about loaded Workers (test/p09 runs them in isolates, one thread each)
// with the loaded code in the project's realm instead: they must answer the same.
describe("P10h loaded Workers in the project's realm", () => {
  it.each(LOADED_IN_REALM)("%s", async (name) => {
    const s = scenarios[name];
    const { transcript } = JSON.parse(
      readFileSync(
        join(import.meta.dirname, `../conformance/${goldenDir(name)}/${name}.json`),
        "utf8",
      ),
    );
    const { runtime } = await loadNodeProject(projectDir(s.project ?? name), {
      openSql: nodeSqliteOpener(),
      files: new MemFilesApi(),
      isolatedModules: undefined,
    });
    try {
      for (const [i, step] of s.steps.entries()) {
        const res = await runtime.fetch(new Request(`http://w${(step as { path: string }).path}`));
        expect(await res.json()).toEqual(transcript[i].body);
      }
    } finally {
      await runtime.close();
    }
  });
});
