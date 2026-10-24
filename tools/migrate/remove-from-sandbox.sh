#!/usr/bin/env bash
# Removes webrun-cells from statewalker-sandbox once cellb.dev holds all of it.
# The code never reached sandbox main: it lives only on the branches below, so removal = deleting
# them (on GitHub and locally) and their worktrees. Dry run by default; --apply executes.
#
#   tools/migrate/remove-from-sandbox.sh [--apply]
#
# Environment: SANDBOX_GIT (the sandbox bare repo), SANDBOX_WORKTREES, ARCHIVE (bundle path),
# NO_FETCH=1 to check against the refs already fetched.
set -euo pipefail
APPLY="${1:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SANDBOX_GIT="${SANDBOX_GIT:-$HOME/workspace-statewalker/cellb.dev/.git-bare/cellb}"
SANDBOX_WORKTREES="${SANDBOX_WORKTREES:-$HOME/workspace-statewalker/cellb.dev/worktrees}"
ARCHIVE="${ARCHIVE:-$HOME/workspace-statewalker/cellb.dev/session/archive/statewalker-sandbox-webrun-cells-2026-10-24.bundle}"
BRANCHES=(webrun-cells feat/port-conformance-tests fix/celld-alarm-handover plan/port-conformance-tests)
WORKTREES=(webrun-cells feat-port-conformance-tests fix-celld-alarm-handover plan-port-conformance-tests)
# the one sandbox commit outside apps/webrun-cells; its file was copied to packages/cellb/docs
COPIED=(3f0151e746ca0266b38dcce5716b016516a0ab40)
g() { git -C "$SANDBOX_GIT" "$@"; }
run() { if [ "$APPLY" = --apply ]; then echo "+ $*"; "$@"; else echo "would run: $*"; fi; }

[ -n "${NO_FETCH:-}" ] || g fetch -q origin --prune
# 1. Nothing new landed on the branch since the move: every commit past main is in cellb.dev.
for c in $(g rev-list origin/main..origin/webrun-cells); do
  grep -q "^$c " "$HERE/commit-map.txt" || [[ " ${COPIED[*]} " == *" $c "* ]] ||
    { echo "not in cellb.dev: $(g log -1 --format='%h %s' "$c")" >&2; exit 1; }
done
# 2. The side branches are all merged into it.
for b in "${BRANCHES[@]}"; do
  g merge-base --is-ancestor "origin/$b" origin/webrun-cells || { echo "origin/$b is not merged" >&2; exit 1; }
done
# 3. Main never had the code.
[ -z "$(g ls-tree origin/main apps/webrun-cells)" ] || { echo "sandbox main has apps/webrun-cells" >&2; exit 1; }
# 4. The archive still holds every branch tip (the sandbox SHAs in commit-map.txt stay resolvable).
git bundle verify -q "$ARCHIVE"
for b in "${BRANCHES[@]}"; do
  git bundle list-heads "$ARCHIVE" | grep -q "^$(g rev-parse "origin/$b") " ||
    { echo "archive lacks origin/$b" >&2; exit 1; }
done
echo "checks passed: cellb.dev and $ARCHIVE hold everything"

for w in "${WORKTREES[@]}"; do
  [ -d "$SANDBOX_WORKTREES/$w" ] && run g worktree remove "$SANDBOX_WORKTREES/$w"
done
run g push origin --delete "${BRANCHES[@]}"
for b in "${BRANCHES[@]}"; do
  g show-ref -q --verify "refs/heads/$b" && run g branch -D "$b"
done
g remote | grep -qx claude && run g remote remove claude
echo "left for you: the bare repo $SANDBOX_GIT (only these branches used it) can be deleted by hand"
