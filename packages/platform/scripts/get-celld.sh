#!/usr/bin/env bash
# Downloads the pinned celld release (the version cellb's interop CI uses) to ~/.cache/celld/celld.
set -euo pipefail
VERSION="${CELLD_VERSION:-0.6.3}"
DIR="${HOME}/.cache/celld"
mkdir -p "$DIR"
if [ ! -x "$DIR/celld" ] || ! "$DIR/celld" --version | grep -q "$VERSION"; then
  curl -fsSL "https://github.com/denoland/celld/releases/download/v$VERSION/celld-x86_64-unknown-linux-gnu.gz" | gunzip > "$DIR/celld.tmp"
  chmod +x "$DIR/celld.tmp" && mv "$DIR/celld.tmp" "$DIR/celld"
fi
"$DIR/celld" --version
