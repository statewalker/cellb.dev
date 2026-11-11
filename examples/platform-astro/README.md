# Astro app for the platform demos

`@statewalker/platform-astro-example`: a small Astro SSR app for the platform's demos ([`../platform-demos`](../platform-demos)): pages,
an API route (`/api/time`), a React island (`Counter`) and a Durable Object (`Visits`, from its
own Worker entry `src/worker.ts`). The platform either bundles Astro's own build (`pnpm build`,
`dist/`) or builds it from these sources alone (`packages/astro-builder`), in its bundler's
object, on the Node runner or in a browser tab.

```sh
pnpm install                         # in examples/ (their own workspace)
(cd ../../packages/platform && pnpm run build)   # the platform's per-host builds (root workspace)
pnpm build                           # astro build (dist/), for the "astro" demo
cd ../platform-demos && npx tsx scripts/e2e.ts all astro astro-src
```
