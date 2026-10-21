/**
 * SQLite session extension over the official WASM build (C API through `sqlite3.capi`):
 * the change capture behind transaction logs. With SQLITE_SESSION_OBJCONFIG_ROWID, tables
 * without a PRIMARY KEY are captured too (node:sqlite cannot do this).
 */
const SESSION_OBJCONFIG_ROWID = 2; // not exported as a constant by the JS bindings
const CHANGESET_REPLACE = 1;

export interface WasmSqlite3 {
  capi: any;
  wasm: any;
}

export function wasmSessionCapture(sqlite3: WasmSqlite3, getDbPointer: () => number) {
  const { capi, wasm } = sqlite3;
  let session = 0;
  const free = () => {
    if (session) capi.sqlite3session_delete(session);
    session = 0;
  };
  return {
    captureCoversRowidTables: true as const,
    captureStart(): void {
      free();
      const stack = wasm.pstack.pointer;
      try {
        const pp = wasm.pstack.allocPtr();
        const rc = capi.sqlite3session_create(getDbPointer(), "main", pp);
        if (rc) throw new Error(`sqlite3session_create failed: ${rc}`);
        session = wasm.peekPtr(pp);
        const pInt = wasm.pstack.alloc(4);
        wasm.poke32(pInt, 1);
        capi.sqlite3session_object_config(session, SESSION_OBJCONFIG_ROWID, pInt);
        capi.sqlite3session_attach(session, null);
      } finally {
        wasm.pstack.restore(stack);
      }
    },
    captureTake(): Uint8Array {
      if (!session) return new Uint8Array();
      const stack = wasm.pstack.pointer;
      try {
        const pN = wasm.pstack.alloc(4);
        const pBuf = wasm.pstack.allocPtr();
        const rc = capi.sqlite3session_changeset(session, pN, pBuf);
        if (rc) throw new Error(`sqlite3session_changeset failed: ${rc}`);
        const n = wasm.peek32(pN);
        const buf = wasm.peekPtr(pBuf);
        const bytes = n ? wasm.heap8u().slice(buf, buf + n) : new Uint8Array();
        if (buf) capi.sqlite3_free(buf);
        return bytes;
      } finally {
        wasm.pstack.restore(stack);
        free();
      }
    },
    captureDiscard(): void {
      free();
    },
    applyChangeset(changeset: Uint8Array): void {
      if (!changeset.byteLength) return;
      const p = wasm.allocFromTypedArray(changeset);
      try {
        const rc = capi.sqlite3changeset_apply(
          getDbPointer(),
          changeset.byteLength,
          p,
          0,
          () => CHANGESET_REPLACE,
          0,
        );
        if (rc) throw new Error(`sqlite3changeset_apply failed: ${rc}`);
      } finally {
        wasm.dealloc(p);
      }
    },
  };
}
