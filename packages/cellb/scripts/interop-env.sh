#!/usr/bin/env bash
# The environment the celld interop tests need, reproducibly:
#   - celld (denoland/celld release binary) and esbuild for its bundler
#   - a local RustFS (S3) on 127.0.0.1:9200, started detached with fresh data
# Prints the variables to export; with a command, runs it in that environment:
#   scripts/interop-env.sh pnpm vitest run test/p11c* test/p11f* test/p11g* test/p11i*
#   scripts/interop-env.sh pnpm playwright test e2e/celld-bucket
# Versions are pinned (bump them together with the recorded goldens).
set -euo pipefail
CELLD_VERSION="${CELLD_VERSION:-0.6.3}"
RUSTFS_VERSION="${RUSTFS_VERSION:-1.0.3}"
RUSTFS_PORT="${RUSTFS_PORT:-9200}"
ROOT="${INTEROP_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/webrun-cells-interop}"
APP="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/bin"

# celld
CELLD="$ROOT/bin/celld-$CELLD_VERSION"
if [ ! -x "$CELLD" ]; then
  curl -fsSL "https://github.com/denoland/celld/releases/download/v$CELLD_VERSION/celld-x86_64-unknown-linux-gnu.gz" \
    | gunzip > "$CELLD.tmp"
  chmod +x "$CELLD.tmp" && mv "$CELLD.tmp" "$CELLD"
fi
"$CELLD" --version | grep -q "$CELLD_VERSION"

# esbuild (celld bundles projects with the esbuild on PATH): the workspace's own
ESBUILD="$(cd "$APP" && node -p 'require.resolve("esbuild/bin/esbuild")' 2>/dev/null || true)"
[ -n "$ESBUILD" ] || ESBUILD="$(ls -d "$APP"/../../node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | tail -1)"
ESBUILD_DIR="$(dirname "$(readlink -f "$ESBUILD")")"

# RustFS
RUSTFS="$ROOT/bin/rustfs-$RUSTFS_VERSION"
if [ ! -x "$RUSTFS" ]; then
  curl -fsSL -o "$ROOT/rustfs.zip" \
    "https://github.com/rustfs/rustfs/releases/download/$RUSTFS_VERSION/rustfs-linux-x86_64-musl-v$RUSTFS_VERSION.zip"
  unzip -o -q "$ROOT/rustfs.zip" rustfs -d "$ROOT/bin" && mv "$ROOT/bin/rustfs" "$RUSTFS" && chmod +x "$RUSTFS"
fi
ENDPOINT="http://127.0.0.1:$RUSTFS_PORT"
if ! curl -fs -o /dev/null "$ENDPOINT/health"; then
  rm -rf "$ROOT/rustfs-data" && mkdir -p "$ROOT/rustfs-data"
  RUSTFS_ACCESS_KEY=rustfsadmin RUSTFS_SECRET_KEY=rustfssecret \
    setsid nohup "$RUSTFS" server --address "127.0.0.1:$RUSTFS_PORT" "$ROOT/rustfs-data" \
    > "$ROOT/rustfs.log" 2>&1 < /dev/null &
  for _ in $(seq 1 60); do curl -fs -o /dev/null "$ENDPOINT/health" && break; sleep 0.5; done
  curl -fs -o /dev/null "$ENDPOINT/health" || { echo "RustFS did not start; see $ROOT/rustfs.log" >&2; exit 1; }
fi
# the tests' bucket ("cells"); creating an existing bucket is harmless (409)
curl -s -o /dev/null --aws-sigv4 "aws:amz:us-east-1:s3" --user rustfsadmin:rustfssecret -X PUT "$ENDPOINT/cells" || true

export CELLD_BIN="$CELLD" ESBUILD_DIR RUSTFS_ENDPOINT="$ENDPOINT"
if [ $# -gt 0 ]; then
  cd "$APP" && exec "$@"
fi
echo "export CELLD_BIN=$CELLD_BIN"
echo "export ESBUILD_DIR=$ESBUILD_DIR"
echo "export RUSTFS_ENDPOINT=$RUSTFS_ENDPOINT"
