# Astro site on CellB

An Astro SSR site (`output: "server"`, the Cloudflare adapter) with a React island and a Durable
Object. The sandbox builds it from its sources (no Vite, no Node), runs it on CellB in the tab, and
its Ship tab makes a deployable Wrangler folder of it.

- `src/pages/*.astro`: pages; `src/pages/api/*.ts`: API routes (`GET`, `POST` exports).
- `src/components/*.tsx`: React components; hydrate one with `client:load` (or `idle`, `visible`).
- `src/worker.ts`: the Worker: Astro's handler, plus the `Visits` Durable Object (`env.VISITS`,
  read from pages with `import { env } from "cloudflare:workers"`).
- `wrangler.jsonc`: bindings. A new Durable Object class needs a binding and a migration.

Links: keep them relative (`posts/hello`, `../`), the preview serves the site under a path of its
own. Check a change with `run_app`, then `http_request` (for example `api/time`).
