# @statewalker/platform-astro-example

A small Astro SSR app for the platform's demos ([`../platform-demos`](../platform-demos)): pages,
an API route (`/api/time`), a React island (`Counter`) and a Durable Object (`Visits`, from its
own Worker entry `src/worker.ts`). The platform either bundles Astro's own build (`pnpm build`,
`dist/`) or builds it from these sources alone (`packages/astro-builder`), in its bundler's
object, on the Node runner or in a browser tab. Private.

```sh
pnpm build                           # astro build (dist/), for the "astro" demo
cd ../platform-demos && npx tsx scripts/e2e.ts all astro astro-src
```
