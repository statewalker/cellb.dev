#!/usr/bin/env bash
# redirect-site.sh <dir> <origin>: writes into <dir> a static site that sends every path to the
# same path (with its query and fragment) on <origin>. For a host that moved: the httpeers sites
# host serves the site's notFound page for any path it has no file for, so index.html and 404.html
# are the same page, and .site/config.json names it.
set -euo pipefail
dir=$1 origin=$2
mkdir -p "$dir/.site"
cat > "$dir/index.html" <<HTML
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Moved to ${origin}</title>
<meta name="robots" content="noindex">
<script>location.replace("${origin}" + location.pathname + location.search + location.hash);</script>
</head><body><p>This demo moved to <a href="${origin}/">${origin}</a>.</p></body></html>
HTML
cp "$dir/index.html" "$dir/404.html"
# The moved demos registered a ServiceWorker at /cellb-sw.js for the whole origin; it would keep
# answering returning visitors' page loads (its update check would fetch the 404 page and fail).
# This version replaces it, unregisters itself and reloads the open pages, which then redirect.
cat > "$dir/cellb-sw.js" <<'JS'
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: "window" })) client.navigate(client.url);
  })());
});
JS
printf '{ "notFound": "/404.html", "cacheControl": "public, no-cache" }\n' > "$dir/.site/config.json"
