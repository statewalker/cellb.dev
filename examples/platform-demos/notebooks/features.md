# Notebook features

The answer is ${answer}, computed by the cell below and shown inline.

```js echo
const answer = 6 * 7;
```

A cell marked `run=false` shows its source and does not run:

```js run=false
throw new Error("this cell must not run");
```

## Data from a loader

The data loader `numbers.json.js` wrote `numbers.json` at build time:
${numbers.length} numbers, summing to ${numbers.reduce((a, b) => a + b, 0)}.

```js
const numbers = FileAttachment("numbers.json").json();
```

## Precomputed SQL

A SQL cell on the `warehouse` database (`warehouse.sql`) runs at build time; the page reads its
result (the `\t` in the query is cooked to a tab, as the page's template does): ${sales.map((d) => `${d.region} ${d.total}`).join(", ")}.

```sql database=warehouse output=sales
SELECT region, SUM(amount) AS total FROM sales WHERE region <> 'none\tsuch' GROUP BY region ORDER BY region
```

## React

A `tsx` cell with types and JSX, a `jsx` cell whose value is a React element, and a `jsx` cell
that passes one to `display`.

```tsx echo
const Door = ({ id, open }: { id: string; open: boolean }) => (
  <b id={id}>{open ? "open" : "closed"}</b>
);
```

```jsx
<Door id="door" open={answer === 42} />
```

```jsx
display(<Door id="door-shut" open={false} />);
```

## Errors

A cell that throws shows where, in this notebook.

```js
function explode() {
  throw new Error("an error, on purpose");
}
explode();
```
