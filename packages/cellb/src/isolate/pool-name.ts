/**
 * The OPFS pool an isolate keeps its facets in (statewalker/cellb.dev#251): its current name, or
 * the former one where a pool of that name exists and none of the current. A former pool is kept
 * as it is, never renamed, so a rollback to a version reading only former names still finds it.
 */
export async function isolatePoolName(
  load: { storageName?: string; legacyStorageName?: string } | undefined,
  exists: (name: string) => Promise<boolean>,
): Promise<string> {
  const name = load?.storageName ?? "isolate";
  const legacy = load?.legacyStorageName;
  if (!legacy || legacy === name) return name;
  return !(await exists(name)) && (await exists(legacy)) ? legacy : name;
}

/**
 * Whether the OPFS entry `entry` is one of the isolate pools of the fragment pool `pool`: a
 * current `.<pool>-ISO-<id>` (fragment ids are lowercase, so no other fragment's name begins so),
 * or a former `.<pool>-iso-<id>` whose `<id>` holds no `-shard-` (every other fragment's pool name
 * holds its own `-shard-<n>` after its id, so none is taken for this one's).
 */
export function isIsolatePoolOf(pool: string, entry: string): boolean {
  if (entry.startsWith(`.${pool}-ISO-`)) return true;
  const former = `.${pool}-iso-`;
  return entry.startsWith(former) && !entry.slice(former.length).includes("-shard-");
}
