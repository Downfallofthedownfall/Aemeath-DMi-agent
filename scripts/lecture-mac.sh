#!/usr/bin/env bash
# ============================================================
# scripts/lecture-mac.sh — 在 macOS 上跑「课堂记录模式」
#
# 这只是一层入口：全部逻辑在 scripts/profile-mac.sh（与习题模式共用一份，
# 差异只有 profile 名、端口和几句提示，见那里的「模式表」）。
#
# 用法（参数原样透传）：
#   ./scripts/lecture-mac.sh              # 启动（默认 3083）
#   ./scripts/lecture-mac.sh --port 4000  # 换端口
#   ./scripts/lecture-mac.sh --setup-only # 只做装配，不启动
# ============================================================
set -euo pipefail

# 用 `bash <路径>` 而不是直接执行：不依赖 profile-mac.sh 的可执行位
# （真机踩过：在 Windows 上改文件会把 100755 弄丢，mac 上就是 Permission denied）。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
exec bash "$HERE/profile-mac.sh" lecture "$@"
