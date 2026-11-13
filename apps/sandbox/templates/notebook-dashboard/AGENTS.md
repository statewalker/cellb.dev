# AGENTS.md — notebook-dashboard

A Worker with one Durable Object (`EventLog`, events in its SQLite table) and **notebooks** as
its UI: `notebooks/*.md`, served at `notebooks/<name>.html`.

- `server/index.ts`: `GET api/events` → `[{ id, kind, value, at }]`; `POST api/events`
  `{ kind, value }` adds one.
- `notebooks/index.md`: the dashboard.

## Writing a notebook

A notebook is Markdown. Each fenced `js` block is a reactive cell (Observable Notebook Kit):

- top-level `const x = …` defines `x` for the other cells; cells run in dependency order and
  re-run when what they read changes; top-level `await` works;
- `display(value)` shows a value (text, an element, `html\`…\``);
- `import * as Plot from "npm:@observablehq/plot"`: npm packages, resolved in the browser;
- data comes from the Worker with relative URLs: `await (await fetch("../api/events")).json()`.

A new file `notebooks/report.md` is a new page at `notebooks/report.html`: write reports there.
Check a change: `run_app`, then `http_request` `notebooks/report.html` (the page builds on the
first request; its cells run in the browser).
