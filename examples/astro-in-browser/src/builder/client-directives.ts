/**
 * Astro's default client directives (`client:load`, `idle`, `visible`, `media`, `only`): the
 * scripts Astro inlines into a page with an island, as strings. Where they are depends on the
 * Astro version:
 *
 * - astro ≤ 7.4.4: `astro/dist/runtime/client/<name>.prebuilt.js`;
 * - astro 7.4.9 and later: `@astrojs/runtime/dist/internal/client/<name>.prebuilt.js`, a package
 *   astro depends on (`@astrojs/runtime/client/*` in its exports).
 *
 * The project depends on `astro`, not on `@astrojs/runtime`, so a bare import of the latter from
 * the build's entry would take whatever version the registry calls latest. Instead the package is
 * taken as `astro` sees it (the version astro's own package.json pins), and each script's source
 * is read here and served to the bundle as a virtual module.
 *
 * The same module as packages/astro-builder/src/client-directives.ts (the builder there was
 * ported from this one).
 */
import type { Mount, PackageStore } from "@statewalker/webrun-bundler";

export const CLIENT_DIRECTIVES = ["load", "idle", "visible", "media", "only"] as const;
export type ClientDirective = (typeof CLIENT_DIRECTIVES)[number];

async function readText(m: Mount, path: string): Promise<string | undefined> {
  const full = `${m.root.replace(/\/$/, "")}/${path}`;
  if (!(await m.files.exists(full))) return undefined;
  const chunks: Uint8Array[] = [];
  for await (const c of m.files.read(full)) chunks.push(c);
  return new TextDecoder().decode(await new Blob(chunks as BlobPart[]).arrayBuffer());
}

async function readAll(m: Mount, dir: string) {
  const out: Partial<Record<ClientDirective, string>> = {};
  for (const name of CLIENT_DIRECTIVES) {
    const text = await readText(m, `${dir}/${name}.prebuilt.js`);
    if (text === undefined) return undefined;
    out[name] = text;
  }
  return out as Record<ClientDirective, string>;
}

/** The directives' module sources, from the `astro` the project depends on. */
export async function clientDirectiveSources(
  packages: PackageStore,
  project: Mount,
  root: string,
): Promise<Record<ClientDirective, string>> {
  const astro = await packages.get("astro", { mount: project, path: `${root}/package.json` });
  if (!astro) throw new Error("the project does not depend on astro");
  const own = await readAll(astro, "dist/runtime/client");
  if (own) return own;
  const runtime = await packages.get("@astrojs/runtime", {
    mount: astro,
    path: `${astro.root.replace(/\/$/, "")}/package.json`,
  });
  const fromRuntime = runtime && (await readAll(runtime, "dist/internal/client"));
  if (fromRuntime) return fromRuntime;
  throw new Error(
    `astro ${astro.manifest?.version ?? "?"}: no prebuilt client directives in astro or @astrojs/runtime`,
  );
}
