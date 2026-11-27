/**
 * "Remove with data" across the tabs of an origin (statewalker/cellb.dev#252). The shards of the
 * fragment host are split over the tabs, so the tab removing a fragment runs only some of them.
 * It leaves a marker in the origin's OPFS for every shard (`<id>@<shard>`, in
 * `.cellb-fragment-removals`); the tabs it tells (a BroadcastChannel) remove the fragment in the
 * shards they run, and every shard deletes the fragment's data for a marker of its own before it
 * loads the fragment again, and at its start, so a shard started later (another tab, a reload)
 * does not bring the old data back. A shard clears its marker once the data is gone.
 *
 * Fragment ids are `[a-z0-9._-]`, so `@` separates them from the shard's number.
 */

/** The OPFS directory of the markers. */
export const REMOVALS_DIR = ".cellb-fragment-removals";

/**
 * The BroadcastChannel the tabs tell each other on: `{ removed: <id>, epoch }`. A tab that added
 * the fragment after `epoch` (a re-add) keeps it: the removal is older than its copy.
 */
export const REMOVALS_CHANNEL = "cellb:fragment-removals";

const markerName = (id: string, shard: number) => `${id}@${shard}`;

type Dir = FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };

async function markers(create: boolean): Promise<Dir | undefined> {
  const root = await navigator.storage.getDirectory();
  try {
    return (await root.getDirectoryHandle(REMOVALS_DIR, { create })) as Dir;
  } catch {
    return undefined; // none yet
  }
}

/**
 * Leave a marker for every shard: each deletes the fragment's data before it serves it again. The
 * marker holds the removal's epoch (its time, unique), so a shard clears only the marker of the
 * removal it applied, never a newer one. Returns the epoch.
 */
export async function markRemoval(id: string, shards: number): Promise<number> {
  const epoch = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const dir = (await markers(true)) as Dir;
  for (let shard = 0; shard < shards; shard++) {
    const file = await dir.getFileHandle(markerName(id, shard), { create: true });
    await writeText(file, String(epoch));
  }
  return epoch;
}

/** A small file's text, written through a writable stream, or a sync handle in a worker. */
async function writeText(file: FileSystemFileHandle, text: string): Promise<void> {
  const writable = (
    file as FileSystemFileHandle & {
      createWritable?(): Promise<{ write(t: string): Promise<void>; close(): Promise<void> }>;
    }
  ).createWritable;
  if (writable) {
    const w = await writable.call(file);
    await w.write(text);
    await w.close();
    return;
  }
  const handle = await (
    file as FileSystemFileHandle & {
      createSyncAccessHandle(): Promise<{
        truncate(n: number): void;
        write(b: Uint8Array, o: { at: number }): number;
        flush(): void;
        close(): void;
      }>;
    }
  ).createSyncAccessHandle();
  try {
    handle.truncate(0);
    handle.write(new TextEncoder().encode(text), { at: 0 });
    handle.flush();
  } finally {
    handle.close();
  }
}

/** The epoch in fragment `id`'s marker for shard `shard`, or undefined when there is none. */
export async function removalEpoch(id: string, shard: number): Promise<string | undefined> {
  const dir = await markers(false);
  if (!dir) return undefined;
  try {
    const file = await dir.getFileHandle(markerName(id, shard));
    return await (await file.getFile()).text();
  } catch {
    return undefined;
  }
}

/** The fragments whose data shard `shard` has still to delete. */
export async function pendingRemovals(shard: number): Promise<string[]> {
  const dir = await markers(false);
  if (!dir) return [];
  const suffix = `@${shard}`;
  const ids: string[] = [];
  for await (const name of dir.keys())
    if (name.endsWith(suffix)) ids.push(name.slice(0, -suffix.length));
  return ids;
}

/**
 * Shard `shard` has deleted fragment `id`'s data for the removal of `epoch` (read before it
 * deleted): the marker goes, unless a newer removal has replaced it meanwhile.
 */
export async function clearRemoval(
  id: string,
  shard: number,
  epoch: string | undefined,
): Promise<void> {
  const dir = await markers(false);
  if (!dir) return;
  if (epoch !== undefined && (await removalEpoch(id, shard)) !== epoch) return;
  await dir.removeEntry(markerName(id, shard)).catch(() => {});
}

/** The shards that have still to delete fragment `id`'s data. */
export async function shardsPending(id: string): Promise<number> {
  const dir = await markers(false);
  if (!dir) return 0;
  let n = 0;
  for await (const name of dir.keys()) if (name.startsWith(`${id}@`)) n++;
  return n;
}
