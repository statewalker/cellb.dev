# Running browser hosts on an S3 fleet bucket

A browser host (`src/project/browser-host.ts`, the `/host/` page) can keep its cells in the same
S3 bucket as celld nodes, so the cells move between this browser, other browsers and celld. The
page talks S3 itself, signing each request with SigV4; there are two ways to let it reach the
bucket.

## 1. Directly, with CORS on the bucket

The bucket must accept the page's origin. The headers below are what the S3 store sends and
reads (conditional writes for ownership, user metadata for R2's `celld-r2` record):

```json
[
  {
    "AllowedOrigins": ["https://your-app.example"],
    "AllowedMethods": ["GET", "PUT", "DELETE", "HEAD"],
    "AllowedHeaders": [
      "authorization", "content-type", "x-amz-date", "x-amz-content-sha256",
      "x-amz-meta-*", "if-match", "if-none-match",
      "cache-control", "content-disposition", "content-encoding", "content-language"
    ],
    "ExposeHeaders": ["etag", "last-modified", "x-amz-meta-celld-r2", "content-type",
      "cache-control", "content-disposition", "content-encoding", "content-language"],
    "MaxAgeSeconds": 3600
  }
]
```

AWS: `aws s3api put-bucket-cors --bucket cells --cors-configuration '{"CORSRules": [...]}'`.
RustFS and MinIO accept the same rules through their S3 API.

Bucket settings:

```ts
bucket: { s3: { endpoint: "https://s3.eu-west-1.amazonaws.com", bucket: "cells", prefix: "prod",
  region: "eu-west-1", accessKeyId, secretAccessKey }, node: "browser-<id>" }
```

`prefix` is celld's `s3://BUCKET/PREFIX`. Credentials in a page are visible to its user: give
the page a key limited to the bucket (and prefix), or use the proxy below with credentials kept
server-side by a signing proxy.

## 2. Through a same-origin proxy

No CORS needed: the page sends to its own origin (`/s3/...`), and the proxy forwards to S3
unchanged. SigV4 covers the host and path, so the page signs **as the real endpoint**:

```ts
bucket: { s3: { endpoint: `${location.origin}/s3`, signAs: "https://s3.eu-west-1.amazonaws.com",
  bucket: "cells", prefix: "prod", accessKeyId, secretAccessKey }, node: "browser-<id>" }
```

The proxy must keep the path after `/s3`, set `Host` to the real endpoint and pass the body and
the `authorization`, `x-amz-*`, `if-*` headers through. Vite (as in `browser/vite.config.ts`):

```ts
server: { proxy: { "/s3": { target: "https://s3.eu-west-1.amazonaws.com", changeOrigin: true,
  rewrite: (p) => p.replace(/^\/s3/, "") } } }
```

nginx:

```nginx
location /s3/ {
  proxy_pass https://s3.eu-west-1.amazonaws.com/;
  proxy_set_header Host s3.eu-west-1.amazonaws.com;
  proxy_request_buffering off;
}
```

## What a browser node does in the fleet

- It writes a node record (`nodes/<node>.json`) that celld reads: pressured, placement weight 0,
  and an unroutable address — celld never pushes cells to it and refuses (rather than takes
  over) requests for cells it owns while it is alive.
- It owns the cells requested through it, logs their commits as LTX (changed pages from the
  SQLite WASM page hook), publishes their alarms in the wake index, and keeps R2 objects at
  `r2/<bucket>/<key>`.
- It stops acknowledging writes when its lease could have lapsed (a frozen tab) and releases its
  cells when the host stops.
