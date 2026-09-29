# @statewalker/webrun-cells

Isomorphic Durable Objects runtime targeting celld's Cloudflare-compatible surface,
for browsers and servers. See `docs/plan.md` for the plan and `docs/notes/` for the
findings of each prototype.

```ts
import { createCellRuntime } from "@statewalker/webrun-cells";
import { nodeSqliteOpener } from "@statewalker/webrun-cells/src/adapters/node-sqlite.js" // no exports map yet;
import * as worker from "./worker.js"; // export default { fetch } + DO classes

const rt = createCellRuntime({ worker, durableObjects: { COUNTER: { className: "Counter" } }, openSql: nodeSqliteOpener("./data") });
const res = await rt.fetch(new Request("http://local/counter/a"));
```

`npm test` · `npm run typecheck` · `npm run mutate` (Node ≥ 22.13 for node:sqlite).

Browser host: `npm run browser:dev` (open http://localhost:5173), `npx playwright install chromium && npm run e2e`.
