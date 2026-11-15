#!/usr/bin/env bash
# Root `test:nightly`, run every night by .github/workflows/nightly.yml (statewalker/statewalker-ci's
# nightly.yml, after install and build): the suites no pull request waits on. Each suite runs to
# the end even when an earlier one fails; the script fails if any did, naming them.
#
#   1. cellb in Chromium: every e2e-browser spec (playwright), with celld and a RustFS bucket
#      (scripts/interop-env.sh). Pull requests run only celld-bucket and opfs-bucket (interop.yml).
#   2. The examples' browser suites, on cellb as released (the examples' own workspace and
#      lockfile), as examples.yml's Chromium jobs run them.
#   3. The platform's end-to-end checks on every host (Wrangler, celld, CellB in Node) and in a
#      Chromium tab (packages/platform/README.md, "What is checked, and where").
#
# Chromium for packages/cellb and the platform comes from the workflow's `setup`; the examples'
# from their install below.
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
failed=()

suite() {
  local name="$1"
  shift
  echo "::group::$name"
  if "$@"; then
    echo "::endgroup::"
  else
    echo "::endgroup::"
    echo "::error::nightly suite failed: $name"
    failed+=("$name")
  fi
}

suite "cellb: e2e-browser (playwright, celld + RustFS)" \
  bash -ec 'cd "$1/packages/cellb" && scripts/interop-env.sh pnpm exec playwright test' _ "$root"

# The examples pin their own Playwright: each one's Chromium build is installed after the install.
suite "examples: install" bash -ec '
  cd "$1/examples" && pnpm install --frozen-lockfile
  for d in flue emdash astro-in-browser; do
    (cd "$d" && bash "$1/.github/scripts/install-chromium.sh" pnpm exec playwright)
  done' _ "$root"
suite "examples: flue in tabs" bash -ec 'cd "$1/examples/flue" && pnpm test:browser' _ "$root"
suite "examples: emdash static build" bash -ec 'cd "$1/examples/emdash" && pnpm test:browser' _ "$root"
# As examples.yml's two in-tab jobs run them, plus the specs those jobs leave out.
aib() { suite "examples: astro-in-browser $1" bash -ec 'cd "$1/examples/astro-in-browser"; shift; "$@"' _ "$root" "${@:2}"; }
aib "build in the tab" pnpm exec playwright test test/browser/pkgstore-probe.spec.ts test/browser/build-in-browser.spec.ts test/browser/cells-lab.spec.ts
aib "emdash in the tab" pnpm exec playwright test test/browser/emdash-in-browser.spec.ts
aib "emdash in the tab, in memory" env EMDASH_STORE=0 pnpm exec playwright test test/browser/emdash-in-browser.spec.ts
aib "emdash admin in the tab" pnpm exec playwright test test/browser/emdash-admin-in-browser.spec.ts
# Specs no workflow ran before: the package cache's clean-up and the chooser with saved builds.
# The *-probe specs are measurements run by hand, not checks.
aib "package cache and start page" pnpm exec playwright test test/browser/package-cache.spec.ts test/browser/start-page.spec.ts

suite "platform: e2e on wrangler, celld, cellb" bash -ec '
  cd "$1/packages/platform"
  bash scripts/get-celld.sh
  export PATH="$HOME/.cache/celld:$PWD/node_modules/.bin:$PATH"
  pnpm run build && pnpm run build:apps && pnpm run build:browser
  pnpm run e2e' _ "$root"
suite "platform: e2e in a Chromium tab" bash -ec 'cd "$1/packages/platform" && pnpm run e2e:browser' _ "$root"

if [ ${#failed[@]} -gt 0 ]; then
  printf 'Failed nightly suites:\n' >&2
  printf '  - %s\n' "${failed[@]}" >&2
  exit 1
fi
echo "All nightly suites passed."
