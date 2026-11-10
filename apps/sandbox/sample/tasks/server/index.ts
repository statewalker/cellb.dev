import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

export interface Task {
  id: number;
  title: string;
  done: boolean;
}

// One TaskList per list name, keeping its tasks in its own SQLite database.
export class TaskList extends DurableObject {
  #ready = false;

  #sql() {
    const sql = this.ctx.storage.sql;
    if (!this.#ready) {
      sql.exec(
        "CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)",
      );
      this.#ready = true;
    }
    return sql;
  }

  list(): Task[] {
    return this.#sql()
      .exec<{ id: number; title: string; done: number }>(
        "SELECT id, title, done FROM tasks ORDER BY id",
      )
      .toArray()
      .map((r) => ({ id: r.id, title: r.title, done: !!r.done }));
  }

  add(title: string): Task[] {
    this.#sql().exec("INSERT INTO tasks (title) VALUES (?)", title);
    return this.list();
  }

  toggle(id: number): Task[] {
    this.#sql().exec("UPDATE tasks SET done = 1 - done WHERE id = ?", id);
    return this.list();
  }

  remove(id: number): Task[] {
    this.#sql().exec("DELETE FROM tasks WHERE id = ?", id);
    return this.list();
  }
}

type Env = { LISTS: DurableObjectNamespace<TaskList> };
const app = new Hono<{ Bindings: Env }>();
const list = (c: { env: Env; req: { param(n: string): string } }) =>
  c.env.LISTS.getByName(c.req.param("list"));

app.get("/api/lists/:list/tasks", async (c) => c.json(await list(c).list()));
app.post("/api/lists/:list/tasks", async (c) => {
  const { title } = await c.req.json<{ title: string }>();
  if (!title?.trim()) return c.json({ error: "a task needs a title" }, 400);
  return c.json(await list(c).add(title.trim()));
});
app.post("/api/lists/:list/tasks/:id/toggle", async (c) =>
  c.json(await list(c).toggle(Number(c.req.param("id")))),
);
app.delete("/api/lists/:list/tasks/:id", async (c) =>
  c.json(await list(c).remove(Number(c.req.param("id")))),
);
app.get("/api/hello", (c) => c.json({ hello: "from the server", at: new Date().toISOString() }));

export default app;
