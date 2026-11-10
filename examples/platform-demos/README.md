# @statewalker/platform-demos

Whole apps, built with their own toolchains where they have one, then bundled or compiled by
the platform ([`packages/platform`](../../packages/platform)), and run on Wrangler, celld and
cellb. Private, in the examples' workspace. Unlike the other examples, which use cellb from npm,
these exercise the platform as it is in this checkout: they read its build
(`packages/platform/dist`) and its scripts.

| Demo | What it is | How the platform handles it |
|---|---|---|
| [`../platform-astro`](../platform-astro) | Astro SSR: pages, an API route, a React island, a Durable Object (`Visits`) | `astro build`, then the bundler, in its object (1.2 MB worker) |
| [`../emdash`](../emdash) | [EmDash](https://github.com/emdash-cms/emdash)'s `blog-cloudflare` template (D1, KV sessions, R2 media, cron, passkeys), the example next to this one | `astro build`, then the bundler: 758 files, 38.5 MB in, a 22.9 MB worker out, on the Node runner (or in the object on hosts without the 128 MB limit) |
| `platform-astro`, from sources (`astro-src`) | the same app's sources alone, no `dist/` | built by the platform's port of cellb.dev's in-browser Astro builder, in its object |
| `emdash`, from sources (`emdash-src`) | EmDash's sources alone (28 files, 0.2 MB) | built by the same builder: on the Node runner by default, in the object with `--emdash-src-tier object` |
| `notebooks/` | a Markdown notebook (from statewalker-knowledge's demo) and an Observable Notebook Kit HTML document with Inputs, d3 and Observable Plot | sent as sources; compiled to pages in a `NotebookSite` object; their npm imports come from the site's module server. Then rendered by `packages/notebooks/theme`, an Astro theme the platform builds from its sources |

## How to use it

```sh
pnpm install                         # in examples/ (their own workspace)
(cd ../../packages/platform && pnpm run build)   # the platform's per-host builds (root workspace)
npx tsx scripts/e2e.ts all           # every demo on Wrangler, celld and cellb
npx tsx scripts/e2e.ts celld emdash  # one host, one demo
npx tsx scripts/e2e.ts all astro-src emdash-src                      # built from sources by the platform
CELLD_V8_HEAP_LIMIT_MB=4096 npx tsx scripts/e2e.ts all emdash-src --emdash-src-tier object
CELLD_V8_HEAP_LIMIT_MB=2048 npx tsx scripts/e2e.ts all emdash --emdash-tier object   # EmDash bundled in the object
```

`scripts/e2e.ts` builds an Astro demo when its `dist/` is missing. celld is found at `CELLD_BIN`,
else `~/.cache/celld/celld` (`packages/platform/scripts/get-celld.sh`). The browser checks need
a Chromium: `PW_CHROMIUM` names its binary, as in cellb's suites; pass `--no-browser` to skip
them.

## What each check proves

For each host, the platform is started on it, then for each demo:

- **astro**:
  - the bundle the platform returns is unpacked and started on the same host;
  - the home page renders on the server and counts visits in its Durable Object;
  - a post page, the API route and the client asset answer;
  - in Chromium, the React island hydrates and counts clicks.
- **astro-src, emdash-src**: the same checks, on what the platform built from the sources (the
  Astro build itself in the object, or on the runner for EmDash by default).
- **emdash**:
  - the bundle runs on the same host, with `EMDASH_SITE_URL` set in its `vars`;
  - EmDash's setup wizard applies the template's seed to D1;
  - the home page, a post, the RSS feed and the admin answer;
  - in Chromium, the home page links to the post and the post renders.
- **notebooks**:
  - both notebooks compile to pages with no failures, and the pages import from the site's
    module server;
  - in Chromium, Plot draws 60 dots and the summary cell runs;
  - changing the range input re-runs the dependent cells (100 points);
  - the Markdown notebook draws its plots;
  - the Astro theme (`packages/notebooks/theme`) is built from its sources by the platform and
    set as the site's theme; `/nb/demo/t/plots` and `/nb/demo/t/` render the page models with
    navigation and the cells' `define()` script, and a missing page is a 404;
  - an edit of `index.md` and a rebuild change the themed page and the models, with no new
    theme build;
  - in Chromium, the themed page's cells run (Plot draws 60 dots) and its navigation lists both
    notebooks;
  - the themed site is exported (`POST /nb/demo/export`) with both pages and every module the
    pins name, served by a plain Node file server, and opened in Chromium: the root redirects to
    the home page, its navigation leads to the plots, and Plot draws 60 dots. Every file of the
    site loads from the file server; the only other requests are notebook-kit's built-ins from
    esm.sh, which the check lists.

## Internals

- `scripts/astro-project.ts` turns Astro's Cloudflare build into an input project:
  - `wrangler.json` comes from the adapter's, reduced to what a project declares, with
    `main: server/entry.mjs` and `assets.directory: client`;
  - `server/` holds the Worker's chunks; `client/` holds the static assets.
- The bundler bundles `server/entry.mjs` into one module. Wrangler would upload the chunks with
  `no_bundle`; the platform's build is one file that cellb and celld load the same way.
- EmDash is [`../emdash`](../emdash): from sources, only the app's own files are sent (not its
  tests, screenshots or browser host).

## What will surprise you

- **EmDash logs `Error processing $media https://images.unsplash.com/…`** during setup without
  network access to Unsplash. The seed's sample images are downloaded then, and the posts are
  created without them.
- **The astro visit counter starts above 1**, because the host's readiness probe loads `/` first.
  The check compares two consecutive loads.
