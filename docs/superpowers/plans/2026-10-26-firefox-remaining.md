# The remaining Firefox marks — plan

Branch `fix/firefox-remaining`, package `packages/cellb`. Five Firefox `test.fail` marks remain:
the three two-tab `sharded` specs (`UNCONTROLLED_NAVIGATION`) and `storage-details` in
`celld-projects` and `site-projects` (`CLONE_MESSAGE`). Remove each only when it really passes.

## Root causes (found before planning; probes in `e2e-browser/probes/`)

- **Sharded: Playwright's Firefox, not cellb.** `sw-control.probe.spec.ts`: under the sharded
  ServiceWorker every navigation after the first (reload, new tab, page-initiated `location.assign`)
  is uncontrolled in Firefox, controlled in Chromium. `sw-minimal.probe.spec.ts` narrows it with
  three minimal ServiceWorkers: no fetch handler → controlled; `respondWith(fetch(request))` →
  controlled; a fetch handler that does not respond (the request falls through to the network) →
  **uncontrolled**. Playwright's Firefox (Juggler, `NetworkObserver.js`) wraps every channel's
  `nsINetworkInterceptController` and, when the ServiceWorker does not intercept, takes the channel
  back (`interceptAfterServiceWorkerResets()`); the page then loads without a controller. The
  sharded SW lets navigations fall through.
- **storage-details: cellb throws the error, with the engine's text.** `DurableObjectStorage.put`
  checks the value with `structuredClone` and rethrows a `TypeError` with the engine's message:
  SpiderMonkey's `Function object could not be cloned.`, V8's `() => 1 could not be cloned.`.
  workerd and celld are V8, and cellb's own V8 serializer (`src/v8/serialize.ts`) words its refusals
  as V8 does.

## Tasks

1. **Sharded.** `e2e-browser/pages/sharded/sw.ts` answers navigations with
   `respondWith(fetch(request))` (test page only; cellb's `CellRouter` is not involved). Remove the
   three `UNCONTROLLED_NAVIGATION` marks and the constant. Red: the marks fail as expected on main
   (`firefox-request-body`'s last Firefox log); with the change, Playwright reports "Expected to fail,
   but passed" for all three (`firefox-remaining-sharded-fix.log`); then green without marks,
   `--repeat-each=3` (they are timing specs).
2. **storage-details.** In `put`'s catch, the message comes from cellb's V8 serializer when it
   refuses the value (the engine's message otherwise, prefix stripped as now). Remove the
   `CLONE_MESSAGE` mark and constant. Red: `storage-details` fails in Firefox on `fnValue`; green
   after (`firefox-remaining-storage-*.log`).
3. **Docs** in the same commits: `docs/gaps.md` and `docs/browser-host.md` (the clone-message and
   SW-control items go; the SW-control finding stays as a note in browser-host.md for whoever writes
   a ServiceWorker for Firefox under Playwright), restructure plan §8.
4. **Bar, merge, push**: unit 370/6/1, Chromium 188/12, Firefox 186 passed with 0 expected
   failures / 14 skipped, `mutate:check`, typecheck, Biome; `git merge origin/main`; push.

Not done: no unit test for the message on Node (V8 already produces V8 text there); the proof is the
Firefox spec.

## Follow-up

5. **The sharded demo's ServiceWorker kept POST bodies out in Firefox**: it rebuilt each ingress
   request with `body: req.body`. It now uses `withUrl` (`src/core/request-body.ts`). Proof: a new
   `sharded` step POSTs to `/sharded/cells/echo` (red in Firefox: body `""`; green after).
