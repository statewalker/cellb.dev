// A Durable Object `SqlStorage` over node:sqlite, for testing code written against `ctx.storage.sql`.
import { DatabaseSync } from "node:sqlite";

export function nodeSqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec<T>(query: string, ...bindings: unknown[]) {
      const st = db.prepare(query);
      const args = bindings.map((b) =>
        b instanceof Uint8Array ? b : b instanceof ArrayBuffer ? new Uint8Array(b) : b,
      );
      const isRead = /^\s*(SELECT|PRAGMA|WITH)/i.test(query);
      const rows = (
        isRead ? st.all(...(args as never[])) : (st.run(...(args as never[])), [])
      ) as Record<string, unknown>[];
      // DO storage returns BLOBs as ArrayBuffer.
      const out = rows.map((r) =>
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? v.slice().buffer : v]),
        ),
      ) as T[];
      return Object.assign(out[Symbol.iterator].bind(out), {
        toArray: () => out,
        one: () => {
          if (out.length !== 1) throw new Error(`expected one row, got ${out.length}`);
          return out[0];
        },
        [Symbol.iterator]: () => out[Symbol.iterator](),
      }) as unknown as SqlCursor<T>;
    },
  };
}
