#!/usr/bin/env bash
# ============================================================
# 课堂记录.command — 双击启动（macOS）
#
# 做什么：装配 + 启动课堂记录模式，并在服务就绪后自动打开浏览器。
#
# 这只是一层入口：全部逻辑在 scripts/launch-mac.sh（与习题模式共用一份）。
# 之所以还要留这个文件：macOS 只有 .command 能双击运行，而且它必须放在
# 好找的地方（仓库根）。
#
# 双击后发生什么：
#   1. 首次运行会装依赖 + 构建（几分钟），之后是秒级
#   2. 服务起来后自动打开浏览器（带 token，无需手输）
#   3. 关掉这个终端窗口 = 停止服务
# ============================================================

# 双击运行时 cwd 是 ${HOME}，必须自己定位到脚本所在目录。
#
# ⚠️ 本文件在**仓库根目录**（不是 scripts/ 里），所以仓库根就是脚本所在目录本身。
#    早先这里写了 `ROOT="$(cd .. && pwd)"` —— 那是按"脚本在 scripts/ 里"写的，
#    实际把 ROOT 指到了仓库**外面**，于是 ./scripts/... 全都找不到，
#    双击后什么都起不来。真机踩过：mac 上双击无反应。
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 自检：确认这确实是仓库根（防止文件被挪走/放到别处）
if [ ! -f "$SELF_DIR/package.json" ] || [ ! -f "$SELF_DIR/scripts/launch-mac.sh" ]; then
  printf '\033[31m%s\033[0m\n' "这个文件必须放在仓库根目录（有 package.json 和 scripts/ 的那一层）。"
  printf '当前位置：%s\n' "$SELF_DIR"
  osascript -e "display alert \"课堂记录启动失败\" message \"请把 lecture-launch.command 放在仓库根目录。\" as critical" 2>/dev/null || true
  echo
  echo "按回车关闭…"
  read -r _
  exit 1
fi

# 用 `bash <路径>` 而不是直接执行：不依赖 launch-mac.sh 的可执行位
# （真机踩过：在 Windows 上改文件会把 100755 弄丢，mac 上就是 Permission denied）。
exec bash "$SELF_DIR/scripts/launch-mac.sh" lecture
