---
title: TypeScript, JSX and TSX cells
---

# TypeScript, JSX and TSX cells

PROTOTYPE for statewalker/statewalker-root#236. Every cell below runs in your browser.

## A `ts` cell

```ts
const doors: string[] = ["front", "back", "garage"];
const count: number = doors.length;
```

There are ${count} doors.

## A `jsx` cell with a shadcn component

```jsx
import { useState } from "react";
import { Button } from "./components/ui/button.tsx";

function Counter({ start }) {
  const [clicks, setClicks] = useState(start);
  return <Button variant="outline" onClick={() => setClicks(clicks + 1)}>Clicked {clicks} times</Button>;
}
```

```jsx
<Counter start={count} />
```

## Reactivity: a `Mutable` read as a value

Other cells see `clicks` as a number, and the reactive type check knows it.

```ts
const clicks = Mutable(0);
const increment = () => ++clicks.value;
```

```tsx
<Button onClick={increment}>Mutable clicks: {clicks}</Button>
```

## A `tsx` cell using a real package

```tsx
import { type FsmStateConfig, getStateTransitions } from "@statewalker/fsm";

const door: FsmStateConfig = {
  key: "Door",
  transitions: [
    ["", "*", "Closed"],
    ["Closed", "open", "Open"],
    ["Open", "close", "Closed"],
  ],
};
```

```tsx
<table className="transitions">
  <thead><tr><th>From</th><th>Event</th><th>To</th></tr></thead>
  <tbody>
    {door.transitions!.map(([from, event, to]) => (
      <tr key={`${from}-${event}`}><td>{from || "(initial)"}</td><td>{event}</td><td>{to}</td></tr>
    ))}
  </tbody>
</table>
```

## A built-in library, without esm.sh

notebook-kit loads `html` (htl) from esm.sh; here it comes from the local module server.

```js
html`<b class="from-htl">Rendered by htl</b>`
```

## Code that only shows

```ts run=false
// Not run, not type-checked: a snippet.
startProcesses({ modules: [] });
```
