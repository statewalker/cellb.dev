# Other cells see a Mutable's value, not the Mutable

```ts
const clicks = Mutable(0);
const increment = () => ++clicks.value;
```

```ts
const doubled: number = clicks * 2;
```
