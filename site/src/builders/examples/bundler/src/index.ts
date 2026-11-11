import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

type Env = { ROOMS: DurableObjectNamespace<Room> };
type Entry = { name: string; text: string; at: string };

/** One guestbook per room: its entries in the object's own SQLite database. */
export class Room extends DurableObject {
  sign(name: string, text: string): Entry[] {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS entries (name TEXT, text TEXT, at TEXT)");
    sql.exec("INSERT INTO entries VALUES (?, ?, ?)", name, text, new Date().toISOString());
    return this.entries();
  }
  entries(): Entry[] {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS entries (name TEXT, text TEXT, at TEXT)");
    return sql.exec<Entry>("SELECT name, text, at FROM entries ORDER BY rowid").toArray();
  }
}

const app = new Hono<{ Bindings: Env }>();
const room = (c: { env: Env }, name: string) => c.env.ROOMS.getByName(name);

app.get("/api/rooms/:room", async (c) => c.json(await room(c, c.req.param("room")).entries()));
app.post("/api/rooms/:room", async (c) => {
  const { name, text } = await c.req.json<{ name: string; text: string }>();
  return c.json(await room(c, c.req.param("room")).sign(name, text), 201);
});

export default app;
