import { DurableObject } from "cloudflare:workers";

// A2UI-style messages (v0.9's shape, trimmed): an agent appends them, clients apply them in order.
export type Message =
  | { createSurface: { surfaceId: string; title?: string } }
  | { updateComponents: { surfaceId: string; components: Component[] } }
  | { updateDataModel: { surfaceId: string; path: string; value: unknown } }
  | { deleteSurface: { surfaceId: string } };

/** A component: an id, a type from the catalog, its properties; `children` name other ids. */
export interface Component {
  id: string;
  component: string;
  [prop: string]: unknown;
}

const KINDS = ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"];
const CATALOG = [
  "Column",
  "Row",
  "Card",
  "Heading",
  "Text",
  "Badge",
  "Button",
  "TextField",
  "List",
];

/** Refuses what a client could not render: an unknown kind, a component outside the catalog. */
function check(msg: unknown): Message {
  if (!msg || typeof msg !== "object") throw new Error("a message is an object");
  const kinds = Object.keys(msg).filter((k) => KINDS.includes(k));
  if (kinds.length !== 1) throw new Error(`a message has one of: ${KINDS.join(", ")}`);
  const body = (msg as Record<string, { surfaceId?: unknown; components?: unknown }>)[kinds[0]];
  if (typeof body?.surfaceId !== "string" || !body.surfaceId)
    throw new Error(`${kinds[0]}: surfaceId is missing`);
  if (kinds[0] === "updateComponents") {
    if (!Array.isArray(body.components))
      throw new Error("updateComponents: components is an array");
    for (const c of body.components as Component[]) {
      if (typeof c?.id !== "string") throw new Error("a component has an id");
      if (!CATALOG.includes(c.component))
        throw new Error(`${c.id}: ${c.component} is not in the catalog (${CATALOG.join(", ")})`);
    }
  }
  return msg as Message;
}

const WELCOME: Message[] = [
  { createSurface: { surfaceId: "main", title: "A surface an agent streams" } },
  {
    updateComponents: {
      surfaceId: "main",
      components: [
        { id: "root", component: "Column", children: ["title", "intro", "counter"] },
        { id: "title", component: "Heading", text: "A surface an agent streams" },
        {
          id: "intro",
          component: "Text",
          text: "This screen is a log of A2UI messages in a Durable Object. An agent appends to it (POST api/stream); every client applies the new messages as they come.",
        },
        { id: "counter", component: "Card", title: "Clicks", children: ["count", "plus"] },
        { id: "count", component: "Text", text: { path: "/clicks" } },
        {
          id: "plus",
          component: "Button",
          label: "+1",
          action: { name: "click", context: { clicks: { path: "/clicks" } } },
        },
      ],
    },
  },
  { updateDataModel: { surfaceId: "main", path: "/clicks", value: 0 } },
];

export class SurfaceStream extends DurableObject {
  #sql() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS actions (seq INTEGER PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL)",
    );
    if (!sql.exec("SELECT 1 FROM messages LIMIT 1").toArray().length)
      for (const m of WELCOME)
        sql.exec("INSERT INTO messages (body) VALUES (?)", JSON.stringify(m));
    return sql;
  }
  append(messages: unknown[]): number {
    const sql = this.#sql();
    const checked = messages.map(check); // all or nothing
    for (const m of checked) sql.exec("INSERT INTO messages (body) VALUES (?)", JSON.stringify(m));
    return Number(sql.exec("SELECT max(seq) AS n FROM messages").one().n);
  }
  since(seq: number) {
    const rows = this.#sql()
      .exec<{ seq: number; body: string }>(
        "SELECT seq, body FROM messages WHERE seq > ? ORDER BY seq LIMIT 500",
        seq,
      )
      .toArray();
    return { messages: rows.map((r) => ({ seq: r.seq, message: JSON.parse(r.body) })) };
  }
  act(action: unknown): number {
    const sql = this.#sql();
    sql.exec("INSERT INTO actions (body, at) VALUES (?, ?)", JSON.stringify(action), Date.now());
    return Number(sql.exec("SELECT max(seq) AS n FROM actions").one().n);
  }
  actions(seq: number) {
    const rows = this.#sql()
      .exec<{ seq: number; body: string; at: number }>(
        "SELECT seq, body, at FROM actions WHERE seq > ? ORDER BY seq LIMIT 500",
        seq,
      )
      .toArray();
    return { actions: rows.map((r) => ({ seq: r.seq, at: r.at, ...JSON.parse(r.body) })) };
  }
  reset() {
    const sql = this.ctx.storage.sql;
    sql.exec("DROP TABLE IF EXISTS messages");
    sql.exec("DROP TABLE IF EXISTS actions");
    this.#sql();
  }
}

/** A JSON array, a single message, or JSON Lines (one message per line). */
function parseMessages(text: string): unknown[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("[")) return JSON.parse(t);
  if (!t.includes("\n")) return [JSON.parse(t)];
  return t
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export default {
  async fetch(request: Request, env: { STREAMS: DurableObjectNamespace<SurfaceStream> }) {
    const url = new URL(request.url);
    const stream = env.STREAMS.get(
      env.STREAMS.idFromName(url.searchParams.get("stream") ?? "main"),
    );
    const since = Number(url.searchParams.get("since") ?? 0);
    try {
      if (url.pathname === "/api/stream" && request.method === "GET")
        return Response.json(await stream.since(since));
      if (url.pathname === "/api/stream" && request.method === "POST")
        return Response.json({ last: await stream.append(parseMessages(await request.text())) });
      if (url.pathname === "/api/actions" && request.method === "GET")
        return Response.json(await stream.actions(since));
      if (url.pathname === "/api/actions" && request.method === "POST")
        return Response.json({ seq: await stream.act(await request.json()) });
      if (url.pathname === "/api/reset" && request.method === "POST") {
        await stream.reset();
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 400 });
    }
  },
};
