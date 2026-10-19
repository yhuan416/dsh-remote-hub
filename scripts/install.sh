#!/usr/bin/env bash
# Install dsh-remote-hub into a dsh profile as a profile dependency + selected bundle.
# Usage: ./scripts/install.sh [profile]        (default: web)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:-web}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
MANIFEST="$PROFILE_DIR/package.json"
PATCH="$PROFILE_DIR/cordis.patch.yml"

[ -f "$ROOT/lib/index.js" ] || { echo "error: lib/index.js missing; run this from the repository" >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "error: profile '$PROFILE' not found at $PROFILE_DIR (run dsh web once to create it)" >&2; exit 1; }

mkdir -p "$DSH_HOME/profiles/node_modules" "$PROFILE_DIR/node_modules"
ln -sfn "$ROOT" "$PROFILE_DIR/node_modules/dsh-remote-hub"
ln -sfn "$ROOT" "$DSH_HOME/profiles/node_modules/dsh-remote-hub"
echo "linked: $PROFILE_DIR/node_modules/dsh-remote-hub -> $ROOT"

# The Plugins page only lists packages that are profile dependencies and selected
# bundles; a bare patch row stays invisible there. Register both.
cp "$MANIFEST" "$MANIFEST.bak-$(date +%Y%m%d-%H%M%S)"
node - "$MANIFEST" "$ROOT" <<'NODE'
const fs = require('fs')
const args = process.argv.slice(2)
const manifestPath = args[0]
const root = args[1]
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
manifest.dependencies = Object.assign({}, manifest.dependencies || {})
manifest.dependencies['dsh-remote-hub'] = 'file:' + root
const dsh = manifest.dsh = manifest.dsh || {}
const profile = dsh.profile = dsh.profile || {}
const bundles = profile.bundles = Array.isArray(profile.bundles) ? profile.bundles : []
if (!bundles.includes('dsh-remote-hub')) bundles.push('dsh-remote-hub')
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log('manifest: dependency + bundle selection recorded')
NODE

# Older installs appended a manual patch row; the bundle patch now supplies that
# row, so drop the duplicate when it is the legacy trailing block.
if [ -f "$PATCH" ] && grep -q 'id: remote-hub' "$PATCH"; then
  cp "$PATCH" "$PATCH.bak-$(date +%Y%m%d-%H%M%S)"
  node - "$PATCH" <<'NODE'
const fs = require('fs')
const patchPath = process.argv.slice(2)[0]
const lines = fs.readFileSync(patchPath, 'utf8').split('\n')
const start = lines.findIndex(function (line) { return line.trim().startsWith('# dsh-remote-hub:') })
if (start >= 0 && lines.slice(start).join('\n').includes('id: remote-hub')) {
  fs.writeFileSync(patchPath, lines.slice(0, start).join('\n').replace(/\s+$/, '') + '\n')
  console.log('patch: removed the legacy remote-hub insert block')
} else {
  console.log('patch: a remote-hub row exists outside the legacy block; review it by hand')
}
NODE
fi

echo
echo "next:"
echo "  1. restart dsh web (the bundle selection is composed at startup)"
echo "  2. Settings -> Plugins -> Installed plugins -> dsh-remote-hub"
echo "  3. manage remotes in the '远端链路' section; switch backends from the top bar"
echo "  4. curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3080/remotes/   # 401 = plugin loaded"
