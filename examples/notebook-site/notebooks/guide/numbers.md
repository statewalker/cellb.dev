# Formatting numbers

## Importing a package

`npm:` imports are resolved at build time and served from the site itself.

```js
import {format} from "npm:d3-format";
```

## Using it

```js
format(",.2f")(1234567.891)
```

### A note

Nothing is fetched from a CDN when this page runs.
