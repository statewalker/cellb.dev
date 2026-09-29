# 14 — Backup and restore with OPFS in a real browser

**Objective.** notes/11 validated the backup callback in Node only; the OPFS path
(`sqlite3_js_db_export` from an opfs-sahpool DB, restore through `pool.importDb`) needs a
browser.

**Scenario (`browser/e2e/backup.spec.ts`, page `browser/backup/`).**
1. Worker A: pool `pool-a-…`, backup to an OPFS FilesApi (`webrun-files-browser`,
   directory `cells-backups/`), five increments, `backupNow()`, worker terminated.
2. The backup store holds `cells/Counter/<hex>.sqlite` + `.sqlite.json`, no `.tmp` left.
3. Worker B: **empty** pool `pool-b-…`, same backup store → the cell reads 5 (restored on
   open), increments to 6.
4. Worker C: pool `pool-b-…` **without** backup → reads 6: the restore wrote into the
   persistent pool, not a memory copy.

**Result.** Passes in Chromium 153. Lesson: Vite reloads the page when it discovers a new
dependency mid-test — browser deps are now pre-bundled (`optimizeDeps.include/entries`).

**Code.** `browser/backup/*`, `src/adapters/{wasm-sqlite,files-backup}.ts`.
