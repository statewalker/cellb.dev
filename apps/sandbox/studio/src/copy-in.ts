// Engines that work on a copy of the project (Python, Wasmer) never hold the capability. Before a
// run, the files under `root` that the capability may read are copied in (readTree: each one
// authorized); after it, each change is written back through the capability, authorized again: a
// write the capability refuses is reported as denied, not applied.

import type { Cap } from "./capfs/caps.ts";

const SKIP = ["node_modules", ".git", ".cellb", ".wrangler", "dist", ".astro", ".turbo", ".cache"];
const MAX_FILES = 5000;
const MAX_BYTES = 16 * 1024 * 1024;

export const clip = (s: string, n = 6000) => (s.length > n ? `${s.slice(0, n)}… [cut]` : s);

/** "data/" → "/data"; "" → "/". */
export const rootOf = (root?: string) => (root ? `/${root.replace(/^\/+|\/+$/g, "")}` : "/");

export async function copyIn(cap: Cap, root: string): Promise<[string, Uint8Array][]> {
  const tree = (await cap.call("readTree", root, {
    contents: true,
    skip: SKIP,
    maxFiles: MAX_FILES,
  })) as { path: string; dir?: boolean; data?: Uint8Array }[];
  let bytes = 0;
  const files: [string, Uint8Array][] = [];
  for (const e of tree) {
    if (e.dir || !e.data) continue;
    bytes += e.data.length;
    if (bytes > MAX_BYTES) throw new Error(`EFBIG: more than ${MAX_BYTES} bytes under ${root}`);
    files.push([e.path, e.data]);
  }
  return files;
}

export async function writeBack(cap: Cap, changes: [string, Uint8Array | null][]) {
  const written: string[] = [];
  const deleted: string[] = [];
  const denied: { path: string; error: string }[] = [];
  // The same limits as the way in: a run cannot write more than it could have read.
  let count = 0;
  let bytes = 0;
  for (const [path, data] of changes) {
    count++;
    bytes += data?.length ?? 0;
    if (count > MAX_FILES || bytes > MAX_BYTES) {
      denied.push({ path, error: `EFBIG: over ${MAX_FILES} files or ${MAX_BYTES} bytes written` });
      continue;
    }
    try {
      if (data) {
        await cap.call("writeFileBuffer", path, data);
        written.push(path);
      } else {
        await cap.call("rm", path, { force: true });
        deleted.push(path);
      }
    } catch (err) {
      denied.push({ path, error: String((err as Error)?.message ?? err) });
    }
  }
  return { written, deleted, denied };
}
