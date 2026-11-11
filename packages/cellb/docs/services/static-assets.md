# Static assets

`assets.directory` in the wrangler file serves files before the Worker runs, or instead of a
Worker. The asset server behaves like celld's, which follows Cloudflare's. A project may have
`assets` and no `main`.

```jsonc
{
  "name": "static-assets",
  "compatibility_date": "2026-01-01",
  "assets": { "directory": "./public" }
}
```

This is celld's `static-assets` example ([conformance/celld-examples/static-assets](../../conformance/celld-examples/static-assets/wrangler.jsonc)),
copied unchanged and run by the conformance suite on Node and in Chromium.

## What the asset server does

- It answers `GET` and `HEAD` only. `run_worker_first` is supported, and `assets.binding` exposes
  the server to the Worker as `env.ASSETS`.
- `_redirects` rules apply first (a 301, 302, 303, 307 or 308 to `Location`, 200 as a rewrite,
  `*` captured as `:splat`), then `_headers` rules.
- `html_handling` defaults to `auto-trailing-slash` and redirects with a 307 to the canonical path;
  `force-trailing-slash`, `drop-trailing-slash` and `none` are supported too.
  `not_found_handling` (`single-page-application` or `404-page`) applies, when there is a Worker,
  only to navigation requests.
- Responses carry a strong SHA-256 ETag, `If-None-Match` gives a 304, `Range` gives a 206 or 416,
  and `Cache-Control` is `public, max-age=0, must-revalidate` by default. A file with an unknown
  extension gets no `Content-Type`.

## Where CellB follows Cloudflare instead of celld

| Request | celld 0.6.3 | CellB |
|---|---|---|
| A nested `dir/index.html` | redirected to `dir/`, then not served | served, as on Cloudflare |
| An asset path ending in `/`, except the root | 404 | as on Cloudflare |

## How it is checked

celld's `static-assets` example and CellB's `assets-api`, `assets-drop` and `assets-force`
projects, on Node and in Chromium.

## What breaks

- **An `.assetsignore` file stops the project from loading.** celld does not support it, so CellB
  throws `<directory>/.assetsignore is not supported by celld; remove it` when the assets directory
  holds one, instead of serving or ignoring the file.
