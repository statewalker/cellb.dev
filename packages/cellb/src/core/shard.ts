/**
 * Fixed sharding of cells: a cell lives in shard `shardOf(id, n)` for the
 * lifetime of the deployment. A shard is the unit of ownership (one Web Lock /
 * lease), of storage (one opfs-sahpool — pools are exclusive per worker) and of
 * placement (one worker). Changing `n` requires migration.
 */
export function shardOf(idHex: string, shards: number): number {
  return parseInt(idHex.slice(0, 8), 16) % shards;
}
