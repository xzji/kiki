#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$ROOT/packages/daemon"

echo "==> 构建 @kiki_agent/daemon"
cd "$PKG_DIR"
npm run build

echo "==> 检查 npm 登录状态"
if ! npm whoami >/dev/null 2>&1; then
  echo "未登录 npm。请先执行："
  echo "  npm login"
  echo ""
  echo "请确认已登录且属于 @kiki_agent 组织（https://www.npmjs.com/settings/kiki_agent）。"
  exit 1
fi

echo "当前 npm 用户: $(npm whoami)"

echo "==> 预览发布内容"
npm pack --dry-run

echo "==> 发布到 npm（public）"
npm publish --access public

echo ""
echo "✅ 发布成功。用户可使用："
echo "   npx @kiki_agent/daemon@latest install --server-url <url> --api-key <key>"
