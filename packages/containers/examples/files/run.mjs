// A host FilesApi mounted into a container, with the security policy in the FilesApi itself:
//   /data/input   read-only, and /.private inside it hidden
//   /data/output  writable
// A Python script analyses the input and writes a report; the host reads the report back.
//
//   node examples/files/run.mjs

import {
  createContainer,
  HostMounts,
  installHostFiles,
  wasmerContainerEngine,
} from "@statewalker/cellb-containers";
import { readText, writeText } from "@statewalker/webrun-files";
import {
  CompositeFilesApi,
  FilteredFilesApi,
  newPathFilter,
  readOnly,
} from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

const ANALYSIS = `
import json, os
root = "/data/input"
names = sorted(n for n in os.listdir(root) if os.path.isfile(os.path.join(root, n)))
words = sum(len(open(os.path.join(root, n)).read().split()) for n in names)
report = {"files": len(names), "words": words, "hiddenSeen": os.path.exists(root + "/.private")}
try:
    open(root + "/a.txt", "a").write("tampered")
    report["writeToInput"] = "ok"
except Exception as e:
    report["writeToInput"] = type(e).__name__
with open("/data/output/report.txt", "w") as f:
    f.write(f"files: {report['files']}\\nwords: {report['words']}\\n")
print(json.dumps(report))
`;

/** Runs the example on a Wasmer client (@wasmer/sdk/node or /browser). */
export async function runFilesExample(wasmer) {
  // The host's data.
  const input = new MemFilesApi();
  await writeText(input, "/a.txt", "hello wasm world");
  await writeText(input, "/b.txt", "six words in this second file");
  await writeText(input, "/.private/token", "not for the container");
  const output = new MemFilesApi();

  // What the container may see and do: the policy lives in this FilesApi.
  const view = new CompositeFilesApi(new MemFilesApi())
    .mount("/input", readOnly(new FilteredFilesApi(input, newPathFilter("/.private"))))
    .mount("/output", output);

  // Served on this thread (the Wasmer client's). In a browser, forwardHostFiles(port) sends the
  // calls to whichever thread owns the FilesApi instead.
  const mounts = new HostMounts();
  const uninstall = installHostFiles(mounts);
  const engine = wasmerContainerEngine(wasmer);
  try {
    const c = createContainer(engine, {
      packages: ["python/python"],
      mounts: [{ path: "/data", id: mounts.add(view) }],
    });
    await c.start();
    const run = await c.exec(["python", "-c", ANALYSIS]);
    await c.destroy();
    if (run.exitCode !== 0) throw new Error(run.stderr);
    return { report: JSON.parse(run.stdout), hostOutput: await readText(output, "/report.txt") };
  } finally {
    await engine.close();
    uninstall();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { Wasmer } = await import("@wasmer/sdk/node");
  const wasmer = new Wasmer({ cache: { directory: ".wasmer" } });
  console.log(await runFilesExample(wasmer));
  await wasmer.close();
}
