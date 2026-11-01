export const posts = [
  {
    slug: "hello",
    title: "Hello from the browser",
    summary: "This page was compiled, bundled and served without a server.",
    body: "<p>The builder read these files from a FilesApi, fetched <code>astro</code> and its dependencies from the npm registry, and wrote one Worker module.</p><blockquote>No Node.js was involved in building it.</blockquote>",
  },
  {
    slug: "cells",
    title: "Cells in the browser",
    summary: "cellb runs the Worker in a Dedicated Worker behind a ServiceWorker.",
    body: "<p>Each request goes from the page to the ServiceWorker, to the shard worker, to Astro's <code>App</code>, and back.</p>",
  },
];
