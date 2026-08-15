#!/usr/bin/env bash
#
# manual-check-188.sh — 真实 Windows(188) 手测清单启动器（P10）
#
# 先构建 dist（保证产物最新），再运行 scripts/manual-check-188.mjs。
# 连接凭证通过环境变量传入（不进仓库）：
#   MCHECK_PROFILE=lobster-188 ./scripts/manual-check-188.sh
# 或
#   MCHECK_HOST=192.168.50.188 MCHECK_USER=xxx MCHECK_PASSWORD=xxx \
#     ./scripts/manual-check-188.sh
#
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! [ -x dist/remote-shell.js ]; then
  echo "[manual-check] dist 不存在，先构建..."
  npm run build || exit 1
fi

exec node scripts/manual-check-188.mjs "$@"
