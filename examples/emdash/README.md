# @statewalker/emdash-example

[EmDash](https://github.com/emdash-cms/emdash), the Astro CMS, as its `blog-cloudflare` template
builds it for Cloudflare, run unchanged on cellb: in Node, and entirely in a browser tab served by
any static file server. The package is private: it is a test of cellb, not a library.

## Why it exists

EmDash is a large, real Cloudflare app that cellb did not write: Astro's Cloudflare adapter output
with D1 (Kysely, multi-statement triggers), KV sessions, R2 media, a cron trigger, static assets,
cookies and passkeys, `waitUntil` from `cloudflare:workers`, a top-level `await`, and
`node:module`/`node:crypto` in its dependencies. Running it found and closed those gaps in cellb.

## How to use it

```
pnpm install              # at the repository root; needs network access
pnpm test                 # astro build, then vitest (Node)
pnpm build:static         # astro build, the browser bundle, the static site in dist/static
pnpm serve:static         # python3 -m http.server on 127.0.0.1:8080
pnpm test:browser         # build:static, then Playwright in Chromium against a file server
pnpm dev:browser          # the same host page under Vite, from the sources
```

Astro needs Node.js ≥ 22.23.4. Open `http://127.0.0.1:8080/`: the first visit loads the host page
(`/__cellb/`), which starts the site; every other path of the origin is then the EmDash site, and
`/_emdash/admin` its setup wizard. Keep the host tab open while you use the site.

## Examples

What `test/emdash-on-cellb.test.ts` proves in Node: the build loads with nothing in
`unsupported`, EmDash's setup endpoint applies the template's seed to D1 in its budgeted steps,
and the home page, a seeded post and the RSS feed render.

What `test/static/emdash-static.spec.ts` proves in Chromium, with `dist/static` behind Python's
`http.server`:

1. The host tab loads the files and starts the site; then the file server is **stopped**.
2. EmDash's setup wizard runs (seed into D1), an account is created with a passkey (Chromium's
   virtual authenticator), and its session cookie signs the admin in.
3. A post is written in the editor, a featured image is uploaded to R2 through the media library,
   and the post is saved and published.
4. The home page, the post (with its image read back from R2) and the posts list render; no
   request reached the file server, and the shard logged no error.
5. With the file server back, the host tab is closed and the site reopened at `/`: the
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

The ServiceWorker runs `installProjectRouter` with `root`: EmDash builds absolute paths
(`/_emdash/…`), so it gets the whole origin except `/__cellb/` and `/cellb-sw.js`, as on its own
Cloudflare route. The host tab runs one shard (`joinProjectShards`): the Worker, D1, KV and R2 in
SQLite WASM on OPFS.

### Decisions a reader would otherwise undo

- **The template is unchanged except for its webfonts.** The build runs offline, so the Google
  fonts entry of `astro.config.mjs` and the `<Font>` tags are replaced by system font stacks
  (`src/styles/theme.css`).
- **`.assetsignore` is applied after the build** (`scripts/apply-assetsignore.mjs`), as
  `wrangler deploy` applies it: cellb refuses the file, as celld does.
- **`EMDASH_SITE_URL`** is EmDash's canonical URL. On Cloudflare it reads it from `process.env`;
  the host page sets it to its origin in the project's `vars`; the Node test sets it in
  `process.env`.

### What will surprise you

- **`Error processing $media https://images.unsplash.com/…`** during setup, without network
  access: the template's seed downloads its sample images; the posts are created without them.
- **The cookies of the site are readable by its pages and all `Path=/`.** A ServiceWorker cannot
  set real HTTP cookies; see `packages/cellb/docs/browser-host.md` (What breaks).
- **Sandboxed plugins are off**, as in the template (`worker_loaders` is commented out).
- **`node:crypto` signature checks throw in the browser**: EmDash's plugin registry verifies
  signed releases with them, so installing plugins from the marketplace does not work there.

## License

MIT
