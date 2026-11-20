# Layered files: install once, run read-only

The way Docker builds and runs images, with FilesApis as layers: a **build** container with a
writable FilesApi installs the dependencies (`npm install` writes `node_modules` into it); that
FilesApi then becomes a read-only **base layer** under every **run**, each run adding a writable
layer of its own. The base never changes, the runs never see each other's files, and the run
containers have no network.

Tested in `test/layers.test.ts` (Node 24, `wasmer/edgejs`, the npm registry).

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

## What else fits (not tested)

- **Other installers** should work the same way, since they only write files: `pip install
  --target /app/site-packages` in a Python image, a build script writing `dist/`. Only `npm
  install` in edgejs is tested here.
- **Lifo** has `npm` (it fetches through the host's `fetch`) and mounts a FilesApi through the
  same bridge, so it could run either step; not tried.
- **Durable layers.** `deps` can be any FilesApi (a folder on disk, OPFS, a bucket), so a base
  built once could serve every node.

Not covered yet: the build step in a browser (egress there needs a WISP relay), and pinning a
base layer's content (a content hash per built layer, as Docker image digests).
