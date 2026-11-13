// The e2e's last step: the deployable folder the sandbox built, run by cellb on Node (what
// serve.mjs in the folder does), answering its pages, its compiled modules and its API.
//   tsx test/run-build.ts <dir> <path>...   → one JSON line per path: { path, status, type, body }
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "@statewalker/cellb/node";

const [dir, ...paths] = process.argv.slice(2);
// As serve.mjs: the folder's .cellb-data/ (the preview's data, when the build carries it).
const data = join(dir, ".cellb-data");
const project = await loadProject(dir, existsSync(data) ? { data } : {});
try {
  for (const path of paths) {
    const res = await project.fetch(new Request(`http://localhost${path}`));
    const body = await res.text();
    console.log(
      JSON.stringify({
        path,
        status: res.status,
        type: res.headers.get("content-type"),
        body: body.slice(0, 2000),
      }),
    );
  }
} finally {
  await project.close();
}
process.exit(0);
