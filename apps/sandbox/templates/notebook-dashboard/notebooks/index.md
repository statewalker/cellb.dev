# Events dashboard

This page is a notebook: Markdown whose fenced `js` blocks are reactive cells. They read the
project's own Worker (`../api/events`, a Durable Object's SQLite table) and re-run when what they
read changes. Edit this file, or ask the agent for another chart.

```js
const events = await (await fetch("../api/events")).json()
```

```js
display(html`<p>${events.length} events, ${new Set(events.map((e) => e.kind)).size} kinds, total value ${events.reduce((s, e) => s + e.value, 0)}</p>`)
```

## By kind

```js
const byKind = Object.entries(
  events.reduce((acc, e) => ((acc[e.kind] = (acc[e.kind] ?? 0) + e.value), acc), {}),
).map(([kind, value]) => ({ kind, value }))
```

```js
display(html`<table>
  <thead><tr><th>Kind</th><th>Total value</th></tr></thead>
  <tbody>${byKind.map((r) => html`<tr><td>${r.kind}</td><td>${r.value}</td></tr>`)}</tbody>
</table>`)
```

## Over time

```js
import * as Plot from "npm:@observablehq/plot"
```

```js
display(
  Plot.plot({
    height: 260,
    marginLeft: 40,
    color: { legend: true },
    marks: [
      Plot.lineY(events, { x: (e) => new Date(e.at), y: "value", stroke: "kind" }),
      Plot.dot(events, { x: (e) => new Date(e.at), y: "value", fill: "kind" }),
    ],
  }),
)
```
