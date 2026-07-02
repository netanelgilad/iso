#!/usr/bin/env bash
# scripts/upload-binary.sh <tag> [path-to-workerd-vfs.bin]
# Uploads the forked workerd binary + its checksum to a GitHub release. Run from a machine that
# HAS the fork binary (CI can't build the fork yet — roadmap item). Requires: gh, shasum.
set -euo pipefail
TAG="${1:?usage: upload-binary.sh <tag> [binary-path]}"
BIN="${2:-$HOME/Development/workerd-vfs.bin}"
[ -f "$BIN" ] || { echo "binary not found: $BIN" >&2; exit 1; }
ASSET="workerd-vfs-darwin-arm64.bin"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cp "$BIN" "$TMP/$ASSET"
( cd "$TMP" && shasum -a 256 "$ASSET" >> checksums.binary.txt )
echo "==> uploading $ASSET ($(du -h "$TMP/$ASSET" | cut -f1)) to release $TAG"
gh release upload "$TAG" "$TMP/$ASSET" --clobber
# merge binary checksum into the release's checksums.txt if present
gh release upload "$TAG" "$TMP/checksums.binary.txt" --clobber
echo "==> done. Binary checksum:"; cat "$TMP/checksums.binary.txt"
