# F7 — Firefox and WebKit (plan)

Goal: the browser e2e suite (`packages/cellb/e2e-browser`) runs on Firefox and WebKit as well as
Chromium; what fails there is recorded by cause before anything is fixed. Restructure plan §8 F7.

Success: `pnpm e2e:firefox` and `pnpm e2e:webkit` exit 0 with every failing spec marked
`test.fail`/`test.skip` and a reason; `pnpm e2e` (Chromium) and CI unchanged at 181 passed / 14
skipped; causes recorded in `docs/gaps.md` and `docs/browser-host.md`.

## Tasks

1. **Projects.** `packages/cellb/playwright.config.ts`: the project list comes from `PW_BROWSERS`
   (comma-separated, default `chromium`), so `pnpm e2e`, CI, `interop:browser` and the mutation
   harness keep running Chromium only. `package.json`: `e2e:firefox`, `e2e:webkit`. Browsers are
   Playwright's own builds (`npx playwright install firefox webkit`).
2. **Record.** Run each browser with the celld env (logs `more-browsers-<browser>-<n>.log` in the
   scratchpad). Group failures by cause with the exact error text. Write them in `docs/gaps.md`
   (replacing the "Firefox and WebKit" planned item) and a "Firefox and WebKit" section in
   `docs/browser-host.md`. Commit before any fix.
3. **Fix** only what is clearly a cellb bug and small, test first (the failing spec on that browser
   is the red test). Platform limits stay documented.
4. **Mark** the remaining failures per browser (`test.fail(browserName === …, reason)` for a spec
   that fails deterministically, `test.skip` when it hangs or cannot start), so each run is green.
5. **Bar** (phase-F rules), tick F7 in the restructure plan §8, push.

No new unit tests: the specs themselves are the tests; the config change is exercised by running it.
