# EmDash on CellB

`@statewalker/emdash-example`: [EmDash](https://github.com/emdash-cms/emdash), the Astro CMS, as its `blog-cloudflare` template
builds it for Cloudflare, run unchanged on CellB: in Node, and entirely in a browser tab served by
any static file server. The package is private, since it is a test of CellB and not a library.

**Live demo: <https://cellb-emdash.httpeers.net>**, EmDash served from static files and run in your
tab. The same app built from its sources in the tab: <https://cellb-astro.httpeers.net>
([astro-in-browser](../astro-in-browser/README.md)).

## Why it exists

EmDash is a large, real Cloudflare app that CellB did not write. It is Astro's Cloudflare adapter
output with D1 (Kysely, multi-statement triggers), KV sessions, R2 media, a cron trigger, static assets,
cookies and passkeys, `waitUntil` from `cloudflare:workers`, a top-level `await`, and
`node:module`/`node:crypto` in its dependencies. Running it exposed gaps in CellB around these,
which have since been closed.

This example takes Astro's own build output. [Astro built in a tab](../astro-in-browser)
instead builds the same template from these sources inside a browser tab, and its spec
`emdash-admin-in-browser.spec.ts` drives the same admin flow
(`test/static/admin-flow.ts`, shared) on that build.

## How to use it

```
pnpm install              # in examples/ (their own workspace; CellB from npm); needs network
pnpm test                 # astro build, then vitest (Node)
pnpm build:static         # astro build, the browser bundle, the static site in dist/static
pnpm serve:static         # python3 -m http.server on 127.0.0.1:8080
pnpm test:browser         # build:static, then Playwright in Chromium against a file server
pnpm dev:browser          # builds the app and its ServiceWorker, then the host page under Vite
```

Astro needs Node.js 22.23.4 or later (`engines`); the repository's `.nvmrc` and CI use Node 24.
The static build is published at https://cellb-emdash.httpeers.net by
`.github/workflows/examples-publish.yml`, which is run by hand.

Open `http://127.0.0.1:8080/` (`serve:static`) or the URL Vite prints (`dev:browser`,
`http://localhost:5173/__cellb/` by default). The first visit loads the host page (`/__cellb/`),
which starts the site. Every other path of the origin is then the EmDash site, and
`/_emdash/admin` is its setup wizard. Keep the host tab open while you use the site.

Under `dev:browser` only the host page and its shard worker come from Vite's sources. The app
(`dist/server`, `dist/browser`, `dist/client`) and the ServiceWorker (`dist/static/cellb-sw.js`)
are built once when it starts, so a change to them needs a restart. The ServiceWorker is always
the bundled file at `/cellb-sw.js`, because a module ServiceWorker cannot run Vite's dev modules,
which use dynamic `import()`. It fails with `ServiceWorker cannot be started`.

## Examples

`test/emdash-on-cellb.test.ts` proves in Node that the build loads with nothing in
`unsupported`, that EmDash's setup endpoint applies the template's seed to D1 in its budgeted
steps, and that the home page, a seeded post and the RSS feed render.

What `test/static/emdash-static.spec.ts` proves in Chromium, with `dist/static` behind Python's
`http.server`:

1. The host tab loads the files and starts the site. Then the file server is **stopped**.
2. EmDash's setup wizard runs (seed into D1), an account is created with a passkey (Chromium's
   virtual authenticator), and its session cookie signs the admin in.
3. A post is written in the editor, a featured image is uploaded to R2 through the media library,
   and the post is saved and published.
4. The home page, the post (with its image read back from R2) and the posts list render. No
   request reached the file server, and the shard logged no error.
5. With the file server back, the host tab is closed and the site is reopened at `/`. The
   ServiceWorker sends it to the host page (`/__cellb/?next=/`), and the post is read back from
   OPFS.

Screenshots of each step go to `screenshots/static/`.

## Internals

### The static site (`scripts/build-static.mjs`)

| Path | What |
|---|---|
| `/index.html` | sends a first visit to the host page |
| `/cellb-sw.js` | the ServiceWorker (`browser/sw.ts`, one file at the root, so no `Service-Worker-Allowed` header is needed) |
| `/__cellb/` | the host page (`browser/index.html`, `browser/host.ts`) and its shard worker |
| `/__cellb/app/` | the app: `config.json` (its `wrangler.json`), `worker.js` (`bundleWorkerForBrowser` of `dist/server`), `assets.json` and `assets/` (`dist/client`) |

The ServiceWorker runs `installProjectRouter` with `root`. EmDash builds absolute paths
(`/_emdash/…`), so it gets the whole origin except `/__cellb/` and `/cellb-sw.js`, as it would on
its own Cloudflare route. The host tab runs one shard (`joinProjectShards`) holding the Worker, D1,
KV and R2 in SQLite WASM on OPFS.

### Decisions a reader would otherwise undo

- **The template is unchanged except for its webfonts.** The build runs offline, so the Google
  fonts entry of `astro.config.mjs` and the `<Font>` tags are replaced by system font stacks
  (`src/styles/theme.css`).
- **`.assetsignore` is applied after the build** (`scripts/apply-assetsignore.mjs`), the way
  `wrangler deploy` applies it, because CellB refuses the file, as celld does.
- **`EMDASH_SITE_URL`** is EmDash's canonical URL. On Cloudflare EmDash reads it from
  `process.env`. The host page sets it to its own origin in the project's `vars`, and the Node test
  sets it in `process.env`.

### What will surprise you

- **`Error processing $media https://images.unsplash.com/…`** appears during setup without network
  access. The template's seed downloads its sample images, and the posts are created without them.
- **The site's cookies are readable by its pages, and all of them have `Path=/`.** A ServiceWorker
  cannot set real HTTP cookies; see [Running in a
  browser](../../packages/cellb/docs/browser-host.md#what-breaks).
- **Sandboxed plugins are off**, as in the template (`worker_loaders` is commented out).
- **`node:crypto` signature checks throw in the browser.** EmDash's plugin registry verifies
  signed releases with them, so installing plugins from the marketplace does not work there.

## License

MIT
