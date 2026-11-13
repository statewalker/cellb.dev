import { DurableObject } from "cloudflare:workers";

export interface Event {
  id: number;
  kind: string;
  value: number;
  at: string;
}

// One event log, in the object's own SQLite database. It starts with some sample events.
export class EventLog extends DurableObject {
  #ready = false;

  #sql() {
    const sql = this.ctx.storage.sql;
    if (!this.#ready) {
      sql.exec(
        "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, value REAL NOT NULL, at TEXT NOT NULL)",
      );
      const n = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events").one().n;
      if (n === 0) {
        const kinds = ["signup", "order", "refund"];
        const day = 24 * 3600 * 1000;
        for (let i = 0; i < 30; i++)
          sql.exec(
            "INSERT INTO events (kind, value, at) VALUES (?, ?, ?)",
            kinds[i % 3],
            Math.round(20 + 15 * Math.sin(i / 4) + (i % 7) * 3),
            new Date(Date.UTC(2026, 10, 1) + i * day).toISOString(),
          );
      }
      this.#ready = true;
    }
    return sql;
  }

  list(): Event[] {
    return this.#sql().exec<Event>("SELECT id, kind, value, at FROM events ORDER BY at").toArray();
  }

  add(kind: string, value: number): Event[] {
    this.#sql().exec(
      "INSERT INTO events (kind, value, at) VALUES (?, ?, ?)",
      kind,
      value,
      new Date().toISOString(),
    );
    return this.list();
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: { EVENTS: DurableObjectNamespace<EventLog> }) {
    const url = new URL(request.url);
    const log = env.EVENTS.get(env.EVENTS.idFromName("main"));
    if (url.pathname === "/api/events" && request.method === "GET") return json(await log.list());
    if (url.pathname === "/api/events" && request.method === "POST") {
      const { kind, value } = (await request.json()) as { kind: string; value: number };
      return json(await log.add(String(kind), Number(value)));
    }
    if (url.pathname === "/") return Response.redirect(new URL("notebooks/", url), 302);
    return json({ error: "not found" }, 404);
  },
};
