#!/usr/bin/env bash
# iso installer — curl -fsSL https://raw.githubusercontent.com/netanelgilad/iso/main/install.sh | bash
#
# Downloads the latest iso release (JS dist + the forked workerd binary), installs host deps,
# ad-hoc code-signs the binary (required on macOS or workerd is SIGKILLed), and links `iso` onto
# your PATH. Idempotent: re-running upgrades in place.
set -euo pipefail

REPO="netanelgilad/iso"
ISO_HOME="${ISO_HOME:-$HOME/.iso}"
DIST_ROOT="$ISO_HOME/dist"
GH="https://github.com/$REPO"
API="https://api.github.com/repos/$REPO"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ---- preflight -------------------------------------------------------------------------------
OS="$(uname -s)"; ARCH="$(uname -m)"
if [ "$OS" != "Darwin" ] || [ "$ARCH" != "arm64" ]; then
  die "iso v0.1 ships only for macOS on Apple Silicon (arm64). Detected: $OS/$ARCH.
Other platforms need a workerd-fork build for that target — not yet available (roadmap).
You can still build from source: see $GH#building-from-source."
fi
command -v node  >/dev/null 2>&1 || die "node not found. iso needs Node.js >= 22 (https://nodejs.org)."
command -v npm   >/dev/null 2>&1 || die "npm not found (it ships with Node.js >= 22)."
command -v curl  >/dev/null 2>&1 || die "curl not found."
command -v codesign >/dev/null 2>&1 || die "codesign not found (Xcode command line tools: xcode-select --install)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js >= 22 required; found $(node -v)."

# ---- resolve the release ---------------------------------------------------------------------
VERSION="${ISO_VERSION:-}"
if [ -z "$VERSION" ]; then
  say "Resolving the latest iso release…"
  VERSION="$(curl -fsSL "$API/releases/latest" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).tag_name||"")}catch{console.log("")}})')"
  [ -n "$VERSION" ] || die "could not resolve the latest release from $API/releases/latest (set ISO_VERSION=vX.Y.Z to pin)."
fi
say "Installing iso $VERSION"
DIST_DIR="$DIST_ROOT/$VERSION"
TARBALL_URL="$GH/releases/download/$VERSION/iso-$VERSION.tar.gz"
BINARY_URL="$GH/releases/download/$VERSION/workerd-vfs-darwin-arm64.bin"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ---- download --------------------------------------------------------------------------------
say "Downloading JS dist…"
curl -fSL --progress-bar "$TARBALL_URL" -o "$TMP/iso.tar.gz" || die "download failed: $TARBALL_URL"
say "Downloading workerd runtime (~300MB)…"
curl -fSL --progress-bar "$BINARY_URL" -o "$TMP/workerd-vfs.bin" || die "download failed: $BINARY_URL"

# optional checksum verification
if curl -fsSL "$GH/releases/download/$VERSION/checksums.txt" -o "$TMP/checksums.txt" 2>/dev/null; then
  say "Verifying checksums…"
  ( cd "$TMP" && shasum -a 256 -c <(grep -E 'iso-.*\.tar\.gz|workerd-vfs-darwin-arm64\.bin' checksums.txt | sed 's#\(iso-[^ ]*\.tar\.gz\)#iso.tar.gz#; s#workerd-vfs-darwin-arm64\.bin#workerd-vfs.bin#') ) \
    || warn "checksum verification failed or partial — continuing (report if this persists)."
fi

# ---- extract ---------------------------------------------------------------------------------
say "Extracting to $DIST_DIR…"
rm -rf "$DIST_DIR"; mkdir -p "$DIST_DIR"
tar xzf "$TMP/iso.tar.gz" -C "$DIST_DIR"
# unwrap a single top-level dir if the tarball nests one (e.g. iso-0.1.0/)
if [ ! -f "$DIST_DIR/package.json" ]; then
  inner="$(find "$DIST_DIR" -maxdepth 2 -name package.json -path '*packages/cli*' | head -1)"
  [ -n "$inner" ] && DIST_DIR="$(cd "$(dirname "$inner")/../.." && pwd)"
fi
mv "$TMP/workerd-vfs.bin" "$DIST_DIR/workerd-vfs.bin"
# clear quarantine on everything we just downloaded
xattr -rc "$DIST_DIR" 2>/dev/null || true

# ---- code-sign the binary (CRITICAL on macOS) ------------------------------------------------
say "Ad-hoc code-signing the workerd binary…"
chmod +x "$DIST_DIR/workerd-vfs.bin"
xattr -c "$DIST_DIR/workerd-vfs.bin" 2>/dev/null || true
codesign -s - -f "$DIST_DIR/workerd-vfs.bin" >/dev/null 2>&1 || die "codesign failed on workerd-vfs.bin"

# ---- host + CLI deps -------------------------------------------------------------------------
say "Installing runtime dependencies (npm --omit=dev)…"
( cd "$DIST_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error )

# ---- activate this version -------------------------------------------------------------------
ln -sfn "$DIST_DIR" "$DIST_ROOT/current"
CLI="$DIST_ROOT/current/packages/cli/iso.mjs"
chmod +x "$DIST_DIR/packages/cli/iso.mjs"

# ---- link `iso` onto PATH --------------------------------------------------------------------
pick_bindir() {
  for d in "$HOME/.local/bin" "/usr/local/bin"; do
    case ":$PATH:" in *":$d:"*) if [ -d "$d" ] || mkdir -p "$d" 2>/dev/null; then [ -w "$d" ] && { echo "$d"; return; }; fi ;; esac
  done
  mkdir -p "$HOME/.local/bin" 2>/dev/null && { echo "$HOME/.local/bin"; return; }
  echo ""
}
BINDIR="$(pick_bindir)"
if [ -n "$BINDIR" ]; then
  ln -sfn "$CLI" "$BINDIR/iso"
  say "Linked iso → $BINDIR/iso"
  case ":$PATH:" in
    *":$BINDIR:"*) : ;;
    *) warn "$BINDIR is not on your PATH. Add it:  export PATH=\"$BINDIR:\$PATH\"" ;;
  esac
else
  warn "Could not find a writable bin dir on PATH. Run iso directly: $CLI"
fi

echo
say "iso $VERSION installed."
echo "  Next:  iso host start   &&   iso run base npm install left-pad"
echo "  Docs:  $GH#readme"
