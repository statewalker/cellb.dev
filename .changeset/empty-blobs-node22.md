---
"@statewalker/cellb": patch
---

node:sqlite on Node 22: a zero-length BLOB is stored as a BLOB, not as NULL. Node 22 binds a view whose buffer has no backing store (`new ArrayBuffer(0)`, or a `Uint8Array` made from one) as NULL, so `sql.exec("INSERT … VALUES (?)", new ArrayBuffer(0))` stored NULL where workerd stores an empty BLOB, and the sqlite object store (celld dev's bucket) refused an empty object (`NOT NULL constraint failed: objects.body`). Zero-length bytes are now bound as an empty view over a real buffer. SQLite WASM was not affected.
