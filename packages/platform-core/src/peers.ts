/**
 * Peer dependencies resolved as npm installs them: a package's `peerDependencies` take the
 * version the project declares, not the newest one their own range allows. webrun-bundler's
 * `npmPackages` takes each importer's range as it is, so `@astrojs/react` (react as a peer,
 * `^17 || ^18 || ^19`) and a project pinning `react@19.2.4` would bundle two Reacts, and hooks
 * fail ("Invalid hook call"). A name the importer does not declare at all also comes from the
 * project's declaration, as a hoisted install would give it.
 */
import type { Importer, Mount, PackageManifest, PackageStore } from "@statewalker/webrun-bundler";
import { type FilesApi, tryReadText } from "@statewalker/webrun-files";

const RANGE_FIELDS = ["dependencies", "optionalDependencies", "devDependencies"] as const;

export async function projectPeers(
  inner: PackageStore,
  files: FilesApi,
  root = "/",
): Promise<PackageStore> {
  const text = await tryReadText(files, `${root.replace(/\/$/, "")}/package.json`);
  const manifest = (text ? JSON.parse(text) : {}) as PackageManifest;
  const declared = (name: string) => RANGE_FIELDS.some((f) => manifest[f]?.[name]);
  const project: Importer = {
    mount: { prefix: "~", files, root, manifest } as Mount,
    path: `${root.replace(/\/$/, "")}/package.json`,
  };
  return {
    get(name, importer) {
      const m = importer.mount.manifest;
      const own = RANGE_FIELDS.some((f) => m?.[f]?.[name]);
      const peer = !!m?.peerDependencies?.[name];
      if (importer.mount.prefix !== "~" && declared(name) && (peer || !own))
        return inner.get(name, project);
      return inner.get(name, importer);
    },
  };
}
