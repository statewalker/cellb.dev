import type { Mount, PackageStore } from "@statewalker/webrun-bundler";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { CLIENT_DIRECTIVES, clientDirectiveSources } from "../src/client-directives.js";

const mount = (prefix: string, files: Record<string, string>): Mount => ({
  prefix,
  root: "/",
  files: new MemFilesApi({ initialFiles: files }),
});
const directives = (dir: string, tag: string) =>
  Object.fromEntries(
    CLIENT_DIRECTIVES.map((n) => [`/${dir}/${n}.prebuilt.js`, `export default "${tag}:${n}";`]),
  );

/** A store answering `astro` for the project and `@astrojs/runtime` for astro only. */
function store(astro: Mount, runtime?: Mount) {
  const asked: string[] = [];
  const packages: PackageStore = {
    async get(name, importer) {
      asked.push(`${name} from ${importer.mount.prefix}`);
      if (name === "astro" && importer.mount.prefix === "~") return astro;
      if (name === "@astrojs/runtime" && importer.mount === astro) return runtime;
      return undefined;
    },
  };
  return { packages, asked };
}
const project = mount("~", { "/package.json": "{}" });

describe("clientDirectiveSources", () => {
  it("reads astro's own prebuilt directives (astro 7.4.4 and earlier)", async () => {
    const { packages, asked } = store(
      mount("npm:astro@7.4.4", directives("dist/runtime/client", "astro")),
    );
    const src = await clientDirectiveSources(packages, project, "/");
    expect(src.load).toBe('export default "astro:load";');
    expect(Object.keys(src).sort()).toEqual([...CLIENT_DIRECTIVES].sort());
    expect(asked).toEqual(["astro from ~"]);
  });

  it("reads them from the @astrojs/runtime astro depends on (astro 7.4.9 and later)", async () => {
    const astro = mount("npm:astro@7.4.9", { "/package.json": "{}" });
    const runtime = mount("npm:@astrojs/runtime@0.1.0", directives("dist/internal/client", "rt"));
    const { packages, asked } = store(astro, runtime);
    const src = await clientDirectiveSources(packages, project, "/");
    expect(src.only).toBe('export default "rt:only";');
    // resolved as astro sees it, not as the project would
    expect(asked).toEqual(["astro from ~", "@astrojs/runtime from npm:astro@7.4.9"]);
  });

  it("names the astro version when neither package has them", async () => {
    const astro = {
      ...mount("npm:astro@9.0.0", {}),
      manifest: { name: "astro", version: "9.0.0" },
    };
    const { packages } = store(astro as Mount, mount("npm:@astrojs/runtime@2.0.0", {}));
    await expect(clientDirectiveSources(packages, project, "/")).rejects.toThrow(
      "astro 9.0.0: no prebuilt client directives",
    );
  });
});
