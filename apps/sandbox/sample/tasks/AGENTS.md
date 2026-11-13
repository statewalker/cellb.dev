# AGENTS.md — tasks

A to-do app: a Hono server with one Durable Object per list, and a React client.

- `server/index.ts` — the Worker (`wrangler.jsonc` → `main`). `TaskList` keeps tasks in its own
  SQLite database (`this.ctx.storage.sql`). Routes: `GET api/lists/:list/tasks`,
  `POST api/lists/:list/tasks` `{ title }`, `POST api/lists/:list/tasks/:id/toggle`.
- `client/index.html` → `client/src/main.tsx` (React), `client/src/api.ts` (fetch with relative URLs).
- npm packages come from `package.json`; add one there before importing it.

Check a change: `run_app`, then `http_request` `GET api/lists/today/tasks`.
A new table or column: create it in `#sql()` with `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE`,
the data of earlier runs is kept (OPFS).
