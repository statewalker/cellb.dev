# Layered files: install once, run read-only

The way Docker builds and runs images, with FilesApis as layers: a **build** container with a
writable FilesApi installs the dependencies (`npm install` writes `node_modules` into it); that
FilesApi then becomes a read-only **base layer** under every **run**, each run adding a writable
layer of its own. The base never changes, the runs never see each other's files, and the run
containers have no network.

Tested in Node (`test/layers.test.ts`: Wasmer `wasmer/edgejs`, Node 24) and in Chromium
(`e2e-browser/layers.spec.ts`: Lifo, the build step through the page's network). Both need the npm
registry. [Observable Framework](observable-framework.md) is built the same way.

## Step 1: build

```ts
import { createContainer, HostMounts, installHostFiles, wasmerContainerEngine } from "@statewalker/cellb-containers";

const deps = new MemFilesApi(); // any FilesApi: the layer being built
await writeText(deps, "/package.json", JSON.stringify({ dependencies: { ms: "2.1.3" } }));
await writeText(deps, "/.npmrc", "node-linker=hoisted\n"); // plain folders: no symlinks

const engine = wasmerContainerEngine(new Wasmer(), { egress: "host" }); // a trusted build step
const mounts = new HostMounts();
installHostFiles(mounts);
const build = createContainer(engine, {
  packages: ["wasmer/edgejs"],
  mounts: [{ path: "/app", id: mounts.add(deps) }],
});
await build.start({ enableInternet: true });
await build.exec(["npm", "install", "--dir", "/app"]); // node_modules lands in `deps`
await build.destroy();
```

- **Egress only here.** `wasmerContainerEngine(wasmer, { egress: "host" })` lets a container ask
  for `enableInternet: true` and gives it the host's network, unfenced (Node only). It is for build
  steps you trust; run containers come from an engine without it, and have no network at all.
- **`node-linker=hoisted`.** edgejs's `npm` is pnpm-flavoured: by default it links packages
  through symlinks into `.pnpm/`, and the host-filesystem protocol has no symlinks. The hoisted
  layout writes plain folders.
- **`--dir /app`.** A host mount cannot be a process's working directory (Wasmer checks the
  working directory before any call reaches the host), so the command runs in `/workspace` and
  points the package manager at the mount.
- Behind a TLS-intercepting proxy, the guest needs the proxy's CA: edgejs has its own certificate
  store, so put the CA file in the image and set `NODE_EXTRA_CA_CERTS` and `npm_config_cafile`.

The build took 5.8 s here, with a fresh Wasmer client and edgejs.

## Step 2: run on the base layer

Freeze the result with `readOnly()` and give each run a layer of its own, with
`@statewalker/webrun-files-composite`:

```ts
import { CompositeFilesApi, cow, readOnly } from "@statewalker/webrun-files-composite";

const base = readOnly(deps);

// read-only base: node_modules from the base, everything else in the run's own layer
const files = new CompositeFilesApi(new MemFilesApi()).mount("/node_modules", base, "/node_modules");
await pool.run({ argv: ["node", "-e", "console.log(require('/data/node_modules/ms')(90000))"], files });

// or copy-on-write: a run may change installed files; the change goes to its own layer
await pool.run({ argv, files: cow(base, new MemFilesApi()) });
```

| Layering | A write to `node_modules` | The base | The next run |
| --- | --- | --- | --- |
| `CompositeFilesApi(top).mount("/node_modules", readOnly(base), …)` | refused (`EACCES` from the volume; the guest sees `EPERM`) | unchanged | a fresh top layer |
| `cow(readOnly(base), top)` | succeeds, in `top` only (deletions as whiteout files) | unchanged | a fresh top layer |

The pool here is an ordinary isolated pool of edgejs containers with no egress; a run on the
layered files took about 0.43 s, the pool included. The base is shared by all runs and read
through each run's mount, so it is installed once, not per run.

## In a browser: a Lifo build step

Wasmer containers in a browser have no network (egress there would need a WISP relay). Lifo's
`npm` fetches through its worker's `fetch`, which in a page is the page's network, so a Lifo
container is the build step in a browser; the npm registry answers cross-origin requests. Its
engine has no network unless created with `egress: "host"`, and the run containers come from an
engine without it (a guard for code you trust, such as your own build and site generators: Lifo
is not a security boundary, and untrusted runs belong in Wasmer, as in the Node flow above):

```ts
// build-worker.ts: the only worker with egress
serveContainerWorker(self, ({ files }) => lifoContainerEngine(lifo, { files, egress: "host" }));
// run-worker.ts
serveContainerWorker(self, ({ files }) => lifoContainerEngine(lifo, { files }));

// the page: the layer is a FilesApi on this thread
const build = createIsolatedPool({
  spawn: () => new Worker(new URL("./build-worker.ts", import.meta.url), { type: "module" }),
  image: { packages: [], enableInternet: true },
  size: 1,
});
await build.run({ argv: ["npm", "install"], files: deps, cwd: "/data" }); // node_modules → deps
await build.close();

const runs = createIsolatedPool({ spawn: () => new Worker(new URL("./run-worker.ts", import.meta.url), { type: "module" }), image: { packages: [] }, size: 2 });
await runs.run({ argv: ["node", "-e", "…require('/data/node_modules/ms')…"], files: cow(readOnly(deps), new MemFilesApi()) });
```

- Lifo mounts a FilesApi directly as the working directory (Wasmer cannot), and writes plain
  folders: no `.npmrc` needed.
- Lifo's `npm` exits 0 when a package cannot be fetched and only warns: check what it installed.
- In Chromium the install of `ms` took about 1.1 s; the runs refuse writes to the read-only base
  with `EACCES` (Lifo passes the volume's code through), keep copy-on-write changes in their own
  layer, and have no network (their `fetch` is refused).

The same Lifo flow runs in Node (`test/observable-framework.test.ts` builds Framework this way).

## What else fits (not tested)

- **Other installers** should work the same way, since they only write files: `pip install
  --target /app/site-packages` in a Python image, a build script writing `dist/`.
- **Mixed engines.** A layer is a FilesApi, so a Lifo build step can serve Wasmer runs and the
  reverse; each test here uses one engine for both steps.
- **Durable layers.** `deps` can be any FilesApi (a folder on disk, OPFS, a bucket), so a base
  built once could serve every node.

Not covered yet: pinning a base layer's content (a content hash per built layer, as Docker image
digests).
