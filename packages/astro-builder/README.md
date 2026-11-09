# @statewalker/cellb-astro-builder

> Private, not published. Used by [`bundler`](../bundler); [`platform`](../platform)'s README
> has the details ("Astro builds").

## What it is

[`examples/astro-in-browser`](../../examples/astro-in-browser)'s builder (`src/builder`), ported
into a package. An Astro project's sources become what Astro's Cloudflare build writes
(`wrangler.json`, `server/entry.mjs`, `client/`), without Vite:

- `astro.config.mjs` is bundled and evaluated, and its integrations' hooks run;
- `.astro` files are compiled with compiler-rs (`./compiler`: its WebAssembly build, or the
  native one on Node);
- webrun-bundler builds the server bundle and the client bundles.

It differs from the example in where it runs and what it builds for:

- **It builds for workerd, celld and cellb**, not only cellb's browser realm.
- **Where the realm cannot evaluate code** (workerd, celld), the whole build runs in a Worker
  Loader isolate (`./loader`, `./loaded-builder`).
- **It fixes four bugs:**
  - compiler-rs's `resolvePath` step after the binding (a project's own island failed to
    resolve);
  - React's automatic JSX runtime;
  - the production React build;
  - rest routes ranking after `/`.

```sh
pnpm --filter @statewalker/cellb-astro-builder test   # the WebAssembly compiler against the native one, routes
```
