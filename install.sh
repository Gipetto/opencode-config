#!/usr/bin/env bash
# managed by opencode-config — run ./install.sh after cloning
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do
  LINK="$(readlink "$SELF")"
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *) SELF="$(dirname "$SELF")/$LINK" ;;
  esac
done
REPO="$(cd "$(dirname "$SELF")" && pwd)"

BINDIR="$HOME/.local/bin"
mkdir -p "$BINDIR"

CMDS=(kin kin-mcp gitnexus sim advocate meditate pact signet-eval)

for cmd in "${CMDS[@]}"; do
  ln -sf "$REPO/bin/$cmd" "$BINDIR/$cmd"
done

echo "linked ${#CMDS[@]} launchers into $BINDIR:"
for cmd in "${CMDS[@]}"; do
  echo "  $BINDIR/$cmd -> $REPO/bin/$cmd"
done
