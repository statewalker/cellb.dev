# Durability by Periodic Backup: The CellBackup Callback and a FilesApi Adapter

_Working document — 28 September 2026_

## 1. Decision

The user proposed a first durability mechanism: a **callback** that periodically backs up
each cell database to separate storage, for example a `@statewalker/webrun-files`
FilesApi. Changeset replication (RPO ≈ 0) comes later.

## 2. API

```ts
interface CellBackup {
  save(cellKey: string, image: Uint8Array, info: BackupInfo): Promise<void>;
  load?(cellKey: string): Promise<Uint8Array | undefined>;   // restore-on-open
  intervalMs?: number;                                          // default 30 s
  onError?(cellKey: string, error: unknown): void;
}
interface BackupInfo { seq: number; takenAt: number; reason: "interval" | "manual" | "close" }

createCellRuntime({ ..., backup, clock })   // runtime.backupNow(), runtime.close()
filesApiBackup(files: FilesApi, { dir?: "/cells", intervalMs?, onError? }): CellBackup
```

Driver port gained two optional methods: `snapshot(): Uint8Array` and
`restore(image)`.

| Driver | snapshot | restore |
|---|---|---|
| node:sqlite | `VACUUM INTO` a temp file | replace the file and reopen (a memory DB becomes file-backed) |
| sqlite-wasm, memory | `sqlite3_js_db_export` | `sqlite3_deserialize` |
| sqlite-wasm, OPFS sahpool | `sqlite3_js_db_export` | close, `pool.importDb(path, image)`, reopen — **not yet run in a browser** |

## 3. Semantics

- A cell is saved when its commit counter changed since the last **successful** save.
- The snapshot is taken synchronously from a timer (between events, after committing the
  implicit transaction) → consistent image. It is **skipped while an async
  `transaction()` holds the database**, and while a previous save of that cell is running.
- Save failures go to `onError`; the object is not affected; the next interval retries.
- `close()` takes a final backup; `evictAll()` does not (models a crash).
- Restore-on-open: if the local database is empty and `load` returns an image, it is
  restored before the class is constructed; events wait behind the input gate.
- FilesApi layout: `{dir}/{Class}/{hexId}.sqlite` + `.json` (info). The image is written to
  a temp file then `move`d (atomic where the backend's move is; on S3 the last complete
  PUT wins).
- **RPO = interval.** The output gate still acknowledges on the local commit: writes after
  the last save can be lost with the local store. This is stated in a test.

## 4. Verified (both drivers: node:sqlite and sqlite-wasm)

| Test | Result |
|---|---|
| only changed cells saved, once per interval, growing `seq` | ✅ |
| FilesApi round trip: a fresh runtime restores on first access and continues | ✅ |
| RPO: a write after the last save is lost after a crash | ✅ (by design) |
| `close()` final backup | ✅ |
| failing save reported, object unaffected, retried | ✅ |
| no snapshot inside an async transaction | ✅ |

Mutants killed: saves unchanged cells; snapshots inside a transaction; no restore on open;
close without final backup.

## 5. Ownership interplay

A backup is only safe if one owner writes it. With leases (docs 05, 09) the owner's
`epoch` should be part of the saved info and the store should reject older epochs
(`FencedManifest`); not wired yet.

## 6. Open threads

- Browser e2e for the sahpool restore path.
- Keep N generations (point-in-time recovery for free) and prune.
- Incremental backups (changed pages) for large cells; compression.
- Which store for browsers: OPFS copy (same device), a peer via httpeers, or S3.
