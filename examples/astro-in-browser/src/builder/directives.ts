/**
 * Astro's built-in client directives (`client:load`, `idle`, `visible`, `media`, `only`): the
 * prebuilt scripts the manifest's `clientDirectives` holds, each a module whose default export
 * is the script as a string.
 *
 * Where they are depends on the Astro version, so they are looked up, not imported by a fixed
 * path:
 *   - up to astro 7.4.9: `astro/dist/runtime/client/<name>.prebuilt.js`
 *     (`astro/runtime/client/<name>.prebuilt.js`);
 *   - from astro 7.4.10: the client runtime moved to `@astrojs/runtime`, a dependency of
 *     `astro`, at `dist/internal/client/<name>.prebuilt.js`; astro no longer ships them.
 *
 * The modules are self-contained (no imports), so the build serves them as virtual modules,
 * `virtual:astro-in-browser/directive/<name>`, whatever package they came from.
 */
import type { Mount, PackageStore } from "@statewalker/webrun-bundler";

export const DIRECTIVES = ["load", "idle", "visible", "media", "only"] as const;
export const DIRECTIVE_MODULE = "virtual:astro-in-browser/directive/";

async function readText(m: Mount, path: string): Promise<string | undefined> {
  const full = `${m.root.replace(/\/$/, "")}/${path}`;
  if (!(await m.files.stats(full))) return undefined;
  const chunks: Uint8Array[] = [];
  for await (const c of m.files.read(full)) chunks.push(c);
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(bytes);
}

const importer = (m: Mount) => ({ mount: m, path: `${m.root.replace(/\/$/, "")}/package.json` });

/** The directives' modules by name, from the `astro` the project depends on. */
export async function clientDirectiveModules(
  packages: PackageStore,
  project: Mount,
): Promise<Map<string, string>> {
  const astro = await packages.get("astro", importer(project));
  if (!astro) throw new Error("client directives: the project has no astro package");
  const places: [() => Promise<Mount | undefined>, string][] = [
    [async () => astro, "dist/runtime/client"],
    [() => packages.get("@astrojs/runtime", importer(astro)), "dist/internal/client"],
  ];
  for (const [mountOf, dir] of places) {
    const m = await mountOf();
    if (!m) continue;
    const found = new Map<string, string>();
    for (const name of DIRECTIVES) {
      const source = await readText(m, `${dir}/${name}.prebuilt.js`);
      if (source !== undefined) found.set(name, source);
    }
    if (found.size === DIRECTIVES.length) return found;
  }
  throw new Error(
    `client directives: no ${DIRECTIVES.map((n) => `${n}.prebuilt.js`).join(", ")} in ${astro.prefix} (dist/runtime/client) or its @astrojs/runtime (dist/internal/client)`,
  );
}
