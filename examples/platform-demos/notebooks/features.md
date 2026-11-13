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
