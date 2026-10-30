/**
 * A bucket in IndexedDB: an ObjectStore whose conditional writes are atomic across every tab
 * and worker of the origin (each put checks its condition and writes in one readwrite
 * transaction, and IndexedDB serializes overlapping readwrite transactions). No synchronous
 * file handle is involved, so any number of workers can use it at once: with in-memory SQLite
 * per cell and the bucket's page-level logs (LTX), cells are not bound to one OPFS pool.
 */
import { type ObjectStore, PreconditionFailedError, type StoredObject } from "./object-store.js";

const STORE = "objects";

function open(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export function idbObjectStore(name: string): ObjectStore {
  let db: Promise<IDBDatabase> | undefined;
  const conn = () => (db ??= open(name));
  return {
    async get(key) {
      const tx = (await conn()).transaction(STORE, "readonly");
      return (await req(tx.objectStore(STORE).get(key))) as StoredObject | undefined;
    },
    async put(key, body, cond, attrs) {
      const tx = (await conn()).transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const etag = crypto.randomUUID();
      let failed = false;
      // Condition and write in the same transaction: atomic for the whole origin.
      store.get(key).onsuccess = (e) => {
        const cur = (e.target as IDBRequest<StoredObject | undefined>).result;
        if (
          (cond?.ifNoneMatch === "*" && cur) ||
          (cond?.ifMatch !== undefined && cur?.etag !== cond.ifMatch)
        ) {
          failed = true;
          tx.abort();
          return;
        }
        store.put(
          { body: body.slice(), etag, attrs, modifiedMs: Date.now() } satisfies StoredObject,
          key,
        );
      };
      try {
        await done(tx);
      } catch (err) {
        if (failed) throw new PreconditionFailedError(key);
        throw err;
      }
      return etag;
    },
    async list(prefix) {
      const tx = (await conn()).transaction(STORE, "readonly");
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`, false, false);
      return ((await req(tx.objectStore(STORE).getAllKeys(range))) as string[]).sort();
    },
    async delete(key) {
      const tx = (await conn()).transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      await done(tx);
    },
  };
}
