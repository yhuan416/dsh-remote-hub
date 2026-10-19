#!/usr/bin/env bash
# Install dsh-remote-hub as a linked plugin in a dsh profile.
# Usage: ./scripts/install.sh [profile]        (default: web)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:-web}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PATCH="$PROFILE_DIR/cordis.patch.yml"

[ -f "$ROOT/lib/index.js" ] || { echo "error: lib/index.js missing; run this from the repository" >&2; exit 1; }
[ -d "$PROFILE_DIR" ] || { echo "error: profile '$PROFILE' not found at $PROFILE_DIR (run dsh web once to create it)" >&2; exit 1; }

mkdir -p "$DSH_HOME/profiles/node_modules" "$PROFILE_DIR/node_modules"
ln -sfn "$ROOT" "$PROFILE_DIR/node_modules/dsh-remote-hub"
ln -sfn "$ROOT" "$DSH_HOME/profiles/node_modules/dsh-remote-hub"
echo "linked: $PROFILE_DIR/node_modules/dsh-remote-hub -> $ROOT"

if grep -q 'dsh-remote-hub' "$PATCH" 2>/dev/null; then
  echo "patch already mentions dsh-remote-hub; nothing appended"
else
  cp "$PATCH" "$PATCH.bak-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
  cat >> "$PATCH" <<'YAML'

# dsh-remote-hub: one dsh window for many backends (reverse proxy + tunnels + switcher)
- insert:
    - id: remote-hub
      name: dsh-remote-hub
YAML
  echo "appended the remote-hub row to $PATCH"
fi

echo
echo "next:"
echo "  1. restart dsh web (the profile may hot-reload on its own)"
echo "  2. curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3080/remotes/   # 401 = plugin loaded"
echo "  3. open the sidebar switcher, or /remotes/?token=<token from the dsh web startup line>"
echo "  4. add backends in the lazily-created store, or through the admin page"
