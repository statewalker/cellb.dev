# Browser notebooks

A notebook is a Markdown file. Fenced `js` blocks are reactive cells — they re-run
when anything they read changes, in dependency order, not in document order.

```js
const n = 24
```

```js
const data = Array.from({length: n}, (_, i) => ({x: i, y: Math.sin(i / 3) * 40 + 50}))
```

Everything below imports Observable Plot straight from npm. No bundler ran: the
import was resolved and transformed on demand, and is served from this origin.

```js
import * as Plot from "npm:@observablehq/plot"
```

```js
display(Plot.line(data, {x: "x", y: "y", stroke: "steelblue", strokeWidth: 2}).plot({height: 240}))
```

```js
display(Plot.dot(data, {x: "x", y: "y", fill: "tomato"}).plot({height: 240}))
```

## A cell that does not compile

The next cell is deliberately broken. The page still builds, the error renders in
place, and the cells after it still run — which is the normal state while writing.

```js
const oops = ;
```

```js
display(`cells after the broken one still execute — n is ${n}`)
```
