#!/usr/bin/env bash
# ============================================================
# 习题模式.command — 双击启动（macOS）
#
# 做什么：装配 + 启动习题模式（Übungen），并在服务就绪后自动打开浏览器。
#
# 为什么单独有这个文件：
#   exercise-mac.sh 是**技术脚本**（终端里跑、前台占住、报错给开发者看）；
#   这个是**日常入口**（双击、出错弹窗、服务就绪才开浏览器）。
#   两者共用同一套装配逻辑，后者只是把体验包了一层。
#
# 双击后发生什么：
#   1. 首次运行会装依赖 + 构建（几分钟），之后是秒级
#   2. 服务起来后自动打开浏览器（带 token，无需手输）
#   3. 关掉这个终端窗口 = 停止服务
# ============================================================

set -uo pipefail

# 双击运行时 cwd 是 ${HOME}，必须自己定位到脚本所在目录。
#
# ⚠️ 本文件在**仓库根目录**（不是 scripts/ 里），所以 ROOT 就是脚本所在目录本身。
#    早先这里写了 `ROOT="$(cd .. && pwd)"` —— 那是按"脚本在 scripts/ 里"写的，
#    实际把 ROOT 指到了仓库**外面**，于是 ./scripts/... 和 ./node_modules/.bin/dsh
#    全都找不到，双击后什么都起不来。
#    真机踩过：mac 上双击无反应。
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SELF_DIR"
cd "$ROOT"

# 自检：确认这确实是仓库根（防止文件被挪走/放到别处）
if [ ! -f "$ROOT/package.json" ] || [ ! -d "$ROOT/scripts" ]; then
  printf '\033[31m%s\033[0m\n' "这个文件必须放在仓库根目录（有 package.json 和 scripts/ 的那一层）。"
  printf '当前位置：%s\n' "$ROOT"
  osascript -e "display alert \"习题启动失败\" message \"请把 exercise-launch.command 放在仓库根目录。\" as critical" 2>/dev/null || true
  echo
  echo "按回车关闭…"
  read -r _
  exit 1
fi

# 出错时弹窗（双击场景看不到终端里的报错，弹窗才看得见）
die_gui() {
  printf '\033[31m%s\033[0m\n' "$1" >&2
  osascript -e "display alert \"习题启动失败\" message \"$1\" as critical" 2>/dev/null || true
  echo
  echo "按回车关闭…"
  read -r _
  exit 1
}

echo "============================================"
echo "  Aemeath 习题模式（Übungen）"
echo "============================================"
echo

# ---- 找一个可用的 Node（双击时 PATH 往往不含 nvm/homebrew）----
# 双击启动的 shell 不读 ~/.zshrc，所以 node 常常"找不到"。
# 这里主动补几个常见位置，避免用户看到莫名其妙的 command not found。
if ! command -v node >/dev/null 2>&1; then
  for p in \
    /opt/homebrew/bin \
    /usr/local/bin \
    "$HOME/.nvm/versions/node"/*/bin \
    "$HOME/.volta/bin" \
    "$HOME/.fnm/aliases/default/bin"
  do
    if [ -x "$p/node" ]; then
      export PATH="$p:$PATH"
      break
    fi
  done
fi
command -v node >/dev/null 2>&1 || die_gui "找不到 Node.js。
请先安装 Node 20 或更新版本：
  · 官网 https://nodejs.org（下载 LTS 版，双击安装）
  · 或终端执行：brew install node"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 20 ] 2>/dev/null || die_gui "Node 版本过低（当前 ${NODE_MAJOR}）。需要 20 或更新版本。"

echo "Node: $(node -v)"
echo

# ---- 装配（复用技术脚本，避免两份逻辑漂移）----
echo "检查环境…（首次运行需要几分钟，之后很快）"
echo
if ! ./scripts/exercise-mac.sh --setup-only; then
  die_gui "环境装配失败。请把上面终端里的报错发给开发者。"
fi

echo
echo "--------------------------------------------"
echo " 正在启动…浏览器会自动打开"
echo " --------------------------------------------"
echo " · 这个窗口**不要关**（关了服务就停了）"
echo " · 要停止：关掉这个窗口，或按 Control-C"
echo

# ---- 启动并抓取带 token 的地址，就绪后开浏览器 ----
PORT="${AEMEATH_EXERCISE_PORT:-3084}"
URL_FILE="$(mktemp -t aemeath-exercise-url)"

# ⚠️ 必须显式给 DSH_HOME，且**与 exercise-mac.sh 一致**（仓库内 .dsh-home）。
#    真机踩过：干净 shell 下不设它，dsh 会去读 ~/.dsh ——
#    那里没有 exercise profile（我们刚把 profile 链到了 .dsh-home/profiles/），
#    于是报 "profile 不存在"，或者更糟：读到用户全局 dsh 的另一套配置。
DSH_HOME="$ROOT/.dsh-home"
export DSH_HOME

# 后台跑服务，同时监听它的输出（不阻塞终端）
./node_modules/.bin/dsh --profile exercise --port "$PORT" 2>&1 | while IFS= read -r line; do
  printf '%s\n' "$line"
  # dsh 打印形如：dsh web: http://127.0.0.1:3084/?token=xxxx
  case "$line" in
    *"dsh web: http"*)
      url="$(printf '%s' "$line" | sed -n 's/.*\(http[^ ]*\).*/\1/p')"
      if [ -n "$url" ] && [ ! -s "$URL_FILE" ]; then
        printf '%s' "$url" > "$URL_FILE"
        echo
        echo ">>> 打开：$url"
        open "$url" 2>/dev/null || true
      fi
      ;;
  esac
done

# 服务退出
echo
echo "服务已停止。"
rm -f "$URL_FILE"
echo "按回车关闭…"
read -r _
