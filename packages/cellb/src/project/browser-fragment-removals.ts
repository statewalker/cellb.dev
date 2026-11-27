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

/** The BroadcastChannel the tabs tell each other on: `{ removed: <id> }`. */
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

/** Leave a marker for every shard: each deletes the fragment's data before it serves it again. */
export async function markRemoval(id: string, shards: number): Promise<void> {
  const dir = (await markers(true)) as Dir;
  for (let shard = 0; shard < shards; shard++)
    await dir.getFileHandle(markerName(id, shard), { create: true });
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

/** Whether shard `shard` has still to delete fragment `id`'s data. */
export async function removalPending(id: string, shard: number): Promise<boolean> {
  const dir = await markers(false);
  if (!dir) return false;
  try {
    await dir.getFileHandle(markerName(id, shard));
    return true;
  } catch {
    return false;
  }
}

/** Shard `shard` has deleted fragment `id`'s data. */
export async function clearRemoval(id: string, shard: number): Promise<void> {
  const dir = await markers(false);
  await dir?.removeEntry(markerName(id, shard)).catch(() => {});
}

/** The shards that have still to delete fragment `id`'s data. */
export async function shardsPending(id: string): Promise<number> {
  const dir = await markers(false);
  if (!dir) return 0;
  let n = 0;
  for await (const name of dir.keys()) if (name.startsWith(`${id}@`)) n++;
  return n;
}
