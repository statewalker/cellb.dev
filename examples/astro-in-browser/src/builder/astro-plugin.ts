/**
 * An esbuild plugin that compiles `.astro` files, from the project or from npm packages, with
 * Astro's compiler, the way Astro's Vite plugin does: the component becomes a module importing
 * `astro/compiler-runtime`, its TypeScript frontmatter is left to esbuild's `ts` loader, and its
 * scoped and global styles are collected per component for the manifest.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import type { Plugin } from "esbuild-wasm";

/** Astro's compiler: `transform` of `@astrojs/compiler-rs` (native on Node, wasm in browsers). */
export type AstroTransform = (
  source: string,
  options: Record<string, unknown>,
) => {
  code: string;
  css: string[];
  diagnostics: { severity: unknown; text: string }[];
  containsHead?: boolean;
  propagation?: boolean;
};

export interface MountLike {
  prefix: string;
  files: FilesApi;
  root: string;
}

async function readText(files: FilesApi, path: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of files.read(path)) chunks.push(c);
  return new TextDecoder().decode(
    chunks.length === 1 ? chunks[0] : new Uint8Array(chunks.flatMap((c) => [...c])),
  );
}

export interface CompiledComponent {
  css: string[];
  containsHead: boolean;
  propagation: boolean;
}

/**
 * `mounts` maps a file id's prefix (`~`, `npm:<name>@<version>`) to its tree; ids are
 * `<prefix><path below root>`, as webrun-bundler names them.
 */
export function astroPlugin(opts: {
  transform: AstroTransform;
  mounts: Map<string, MountLike>;
  /** Filled with each compiled component, by id. */
  components: Map<string, CompiledComponent>;
}): Plugin {
  const locate = (id: string) => {
    let best: MountLike | undefined;
    for (const m of opts.mounts.values())
      if (id.startsWith(`${m.prefix}/`) && (!best || m.prefix.length > best.prefix.length))
        best = m;
    if (!best) throw new Error(`astro-in-browser: no tree for ${id}`);
    return { mount: best, path: `${best.root.replace(/\/$/, "")}${id.slice(best.prefix.length)}` };
  };
  return {
    name: "astro-components",
    setup(b) {
      b.onLoad({ filter: /\.astro$/, namespace: "webrun" }, async (args) => {
        const { mount, path } = locate(args.path);
        const source = await readText(mount.files, path);
        const r = opts.transform(source, {
          filename: args.path,
          normalizedFilename: args.path,
          internalURL: "astro/compiler-runtime",
          sourcemap: "inline",
          resultScopedSlot: true,
          compact: "jsx",
          scopedStyleStrategy: "attribute",
          transitionsAnimationURL: "astro/components/viewtransitions.css",
          // With a resolver, the compiler emits what Astro 7 renders (no legacy $$metadata).
          resolvePath: (specifier: string) => specifier,
        });
        const error = r.diagnostics.find((d) => d.severity === 1 || d.severity === "error");
        if (error) return { errors: [{ text: `${args.path}: ${error.text}` }] };
        opts.components.set(args.path, {
          css: r.css,
          containsHead: !!r.containsHead,
          propagation: !!r.propagation,
        });
        // Style imports the compiler leaves (`?astro&type=style`) are collected above instead.
        const code = r.code.replace(/^import\s+["'][^"']+\?astro&type=style[^"']*["'];?\s*$/gm, "");
        return { contents: code, loader: "ts", resolveDir: "/" };
      });
    },
  };
}
