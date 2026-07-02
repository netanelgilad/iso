#!/usr/bin/env bash
# iso uninstaller
#   curl -fsSL https://raw.githubusercontent.com/netanelgilad/iso/main/uninstall.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/netanelgilad/iso/main/uninstall.sh | bash -s -- --purge
#
# Stops the host, removes the installed code (~/.iso/dist, ~/.iso/run) and the `iso` PATH symlink.
# By default it PRESERVES your data (~/.iso/images, volumes, networks, state.json). Pass --purge to
# remove ~/.iso entirely.
set -euo pipefail

ISO_HOME="${ISO_HOME:-$HOME/.iso}"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }

# ---- stop the host (best effort) -------------------------------------------------------------
ISO_BIN=""
for c in "$ISO_HOME/dist/current/packages/cli/iso.mjs" "$(command -v iso 2>/dev/null || true)"; do
  [ -n "$c" ] && [ -e "$c" ] && { ISO_BIN="$c"; break; }
done
if [ -n "$ISO_BIN" ] && command -v node >/dev/null 2>&1; then
  say "Stopping the iso host (if running)..."
  node "$ISO_BIN" host stop >/dev/null 2>&1 || true
fi
# belt and suspenders: kill stray runtime processes
pkill -9 -f 'workerd-vfs|/.iso/run/workerd.bin' >/dev/null 2>&1 || true

# ---- remove the PATH symlink -----------------------------------------------------------------
for d in "$HOME/.local/bin" "/usr/local/bin"; do
  link="$d/iso"
  if [ -L "$link" ]; then
    target="$(readlink "$link" || true)"
    case "$target" in
      "$ISO_HOME"/dist/*) rm -f "$link" && say "Removed symlink $link" ;;
      *) warn "left $link (points outside iso: $target)" ;;
    esac
  fi
done

# ---- remove installed code + derived build output (NOT user data) ----------------------------
say "Removing installed code ($ISO_HOME/dist, $ISO_HOME/run, $ISO_HOME/base)..."
rm -rf "$ISO_HOME/dist" "$ISO_HOME/run" "$ISO_HOME/base" "$ISO_HOME/host.pid" "$ISO_HOME/host.log"

if [ "$PURGE" = "1" ]; then
  say "Purging ALL iso state ($ISO_HOME)..."
  rm -rf "$ISO_HOME"
  say "iso fully removed."
else
  say "iso uninstalled. Your data is preserved in $ISO_HOME (images, volumes, networks, state.json)."
  echo "  Remove it too with:  rm -rf \"$ISO_HOME\"   (or re-run with --purge)"
fi
