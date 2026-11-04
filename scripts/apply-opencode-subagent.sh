#!/usr/bin/env bash
# 把已安装的 dsh-remote-hub 更新到包含 opencode 原生 subagent 的版本，
# 并在真实 web profile 里加上 opencode 服务与 subagent 工具行。
# 用法：bash scripts/apply-opencode-subagent.sh [opencode-url]
set -euo pipefail

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PLUGIN_DIR="$DSH_HOME_DIR/plugins/dsh-remote-hub"
PROFILE_PATCH="$DSH_HOME_DIR/profiles/web/cordis.patch.yml"
WORKSPACE_REPO="${WORKSPACE_REPO:-/home/yhuan/workspace/gitlab/dsh-remote-hub}"
OPENCODE_URL="${1:-http://192.168.4.50:4096}"

echo "==> plugin: $PLUGIN_DIR"
echo "==> profile: $PROFILE_PATCH"
echo "==> opencode url: $OPENCODE_URL"

if [ ! -d "$PLUGIN_DIR/.git" ]; then
  echo "!! $PLUGIN_DIR is not a git checkout" >&2
  exit 1
fi

echo "==> updating plugin"
git -C "$PLUGIN_DIR" log --oneline -1
if git -C "$PLUGIN_DIR" pull --ff-only 2>/dev/null; then
  echo "==> pulled from origin"
elif [ -d "$WORKSPACE_REPO/lib" ]; then
  echo "!! pull failed, syncing files from $WORKSPACE_REPO"
  cp "$WORKSPACE_REPO/lib/index.js" "$PLUGIN_DIR/lib/index.js"
  cp "$WORKSPACE_REPO/lib/client.js" "$PLUGIN_DIR/lib/client.js"
  cp "$WORKSPACE_REPO/package.json" "$PLUGIN_DIR/package.json"
  git -C "$PLUGIN_DIR" add -A
  git -C "$PLUGIN_DIR" -c user.name=sync -c user.email=sync@local commit -q -m "sync opencode subagent support from workspace" || true
else
  echo "!! cannot update plugin (pull failed and workspace repo missing)" >&2
  exit 1
fi
git -C "$PLUGIN_DIR" log --oneline -1

echo "==> patching profile"
cp "$PROFILE_PATCH" "$PROFILE_PATCH.bak-$(date +%s)"
node - "$PROFILE_PATCH" "$OPENCODE_URL" <<'NODE'
const fs = require('fs')
const file = process.argv[2]
const url = process.argv[3]
const text = fs.readFileSync(file, 'utf8')
if (text.includes('tool-opencode-n100')) {
  console.log('profile already contains tool-opencode-n100; skip')
  process.exit(0)
}
const block = [
  '',
  '# 远端 OpenCode 服务（opencode serve；dsh 只配置 ip:port，部署在目标机独立进行）',
  '- id: remote-hub',
  '  config:',
  '    opencode:',
  '      - id: n100',
  '        label: n100 opencode',
  '        url: ' + url,
  '      # 权限默认自动允许；如需拒绝：opencodePermission: reject',
  '',
  '# 把 opencode 注册为 dsh 原生 subagent 后端',
  '- insert:',
  '    - id: tool-opencode-n100',
  '      name: "@deepseek-ai/dsh-tool-subagent"',
  '      config:',
  '        provider: opencode-n100',
  '        maxDepth: provider-managed',
  '        toolName: subagent_n100',
  '',
].join('\n')
fs.writeFileSync(file, text.replace(/\s*$/, '') + '\n' + block)
console.log('profile patched')
NODE

echo
echo "==> done. restart dsh web (3080) to load the plugin:"
echo "    # 先停掉当前 dsh web，再重新运行你平时启动 3080 的命令"
echo "    # 起来后在会话里应能看到 subagent_n100 工具"