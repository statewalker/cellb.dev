# Static assets

`assets.directory` in the wrangler file serves files before, or instead of, the Worker, with the
behaviour of celld's asset server, which follows Cloudflare's. A project may have `assets` and no
`main`.

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

- `GET` and `HEAD` only; `run_worker_first`; `assets.binding` exposes `env.ASSETS`.
- `_redirects` first (301, 302, 303, 307, 308 to `Location`; 200 rewrites; `*` to `:splat`), then
  `_headers` rules.
- `html_handling` `auto-trailing-slash`, with a 307 to the canonical path;
  `not_found_handling` (with a Worker, only for navigation requests).
- A strong SHA-256 ETag, `If-None-Match` → 304, `Range` → 206 or 416, and
  `Cache-Control: public, max-age=0, must-revalidate` by default. A file with an unknown extension
  gets no `Content-Type`.

## Where CellB follows Cloudflare instead of celld

| Request | celld 0.6.3 | CellB |
|---|---|---|
| A nested `dir/index.html` | redirected to `dir/`, then not served | served, as on Cloudflare |
| An asset path ending in `/`, except the root | 404 | as on Cloudflare |

## How it is checked

celld's `static-assets` example and CellB's `assets-api`, `assets-drop` and `assets-force`
projects, on Node and in Chromium.
