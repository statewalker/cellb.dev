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

## Code that only shows

```ts run=false
// Not run, not type-checked: a snippet.
startProcesses({ modules: [] });
```
