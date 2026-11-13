#!/usr/bin/env bash
# ============================================================
# scripts/launch-mac.sh — 双击启动的那一层（macOS，两个模式共用一份）
#
# 由仓库根的 lecture-launch.command / exercise-launch.command 调用：
#   scripts/launch-mac.sh <lecture|exercise>
#
# 做什么：找 Node → 装配 → 启动 → 服务就绪后自动打开浏览器。
#
# 和 profile-mac.sh 的分工：
#   profile-mac.sh 是**技术脚本**（终端里跑、前台占住、报错给开发者看）；
#   这个是**日常入口**（双击、出错弹窗、服务就绪才开浏览器）。
#   装配逻辑只在 profile-mac.sh 里有一份，这里只是把体验包了一层。
#
# 双击后发生什么：
#   1. 首次运行会装依赖 + 构建（几分钟），之后是秒级
#   2. 服务起来后自动打开浏览器（带 token，无需手输）
#   3. 关掉这个终端窗口 = 停止服务
# ============================================================

set -uo pipefail

# 双击运行时 cwd 是 ${HOME}，必须自己定位。本文件在 scripts/ 里，仓库根是上一级。
SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
ROOT="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
cd "$ROOT"

# ---- 模式表 ----
PROFILE="${1:-}"
case "$PROFILE" in
  exercise)
    TITLE="Aemeath 习题模式（Übungen）"
    FAIL_TITLE="习题启动失败"
    PORT="${AEMEATH_EXERCISE_PORT:-3084}"
    ;;
  lecture)
    TITLE="Aemeath 课堂记录模式"
    FAIL_TITLE="课堂记录启动失败"
    PORT="${AEMEATH_LECTURE_PORT:-3083}"
    ;;
  *)
    echo "用法：$(basename "$SCRIPT_PATH") <lecture|exercise>" >&2
    exit 2
    ;;
esac

# 出错时弹窗（双击场景看不到终端里的报错，弹窗才看得见）
die_gui() {
  printf '\033[31m%s\033[0m\n' "$1" >&2
  osascript -e "display alert \"${FAIL_TITLE}\" message \"$1\" as critical" 2>/dev/null || true
  echo
  echo "按回车关闭…"
  read -r _
  exit 1
}

# 自检：确认这确实是仓库根（防止脚本被挪走/放到别处）
if [ ! -f "$ROOT/package.json" ] || [ ! -f "$ROOT/scripts/profile-mac.sh" ]; then
  die_gui "找不到仓库根（需要 package.json 和 scripts/profile-mac.sh）。当前位置：${ROOT}"
fi

echo "============================================"
echo "  ${TITLE}"
echo "============================================"
echo

# ---- 找一个可用的 Node（双击时 PATH 往往不含 nvm/homebrew）----
# 双击启动的 shell 不读 ~/.zshrc，所以 node 常常"找不到"。
# 这里主动补几个常见位置，避免用户看到莫名其妙的 command not found。

# 打印某个 node 的"主版本 次版本 补丁"（空格分隔，纯数字）；跑不起来打印 "0 0 0"
# parseInt 是为了把 `0-nightly2026…` 这类后缀削掉：下面要拿它们做整数比较。
node_version_of() {
  "$1" -p 'process.versions.node.split(".").slice(0,3).map((s) => parseInt(s, 10) || 0).join(" ")' 2>/dev/null || echo "0 0 0"
}

# 某个 node 是否 ≥ 20（能启动的最低线；22.13 以下会在后面给警告）
node_usable() {
  local maj min pat
  read -r maj min pat <<< "$(node_version_of "$1")"
  [ "${maj:-0}" -ge 20 ] 2>/dev/null
}

NODE_BIN=""
if command -v node >/dev/null 2>&1 && node_usable "$(command -v node)"; then
  NODE_BIN="$(command -v node)"
else
  # nvm 可能装了好几个版本：挑**最新**的那个。
  # ⚠️ 早先是"glob 到第一个就用"—— glob 按字典序，v18 排在 v22 前面，
  #    于是明明装了够新的版本，却选中旧的、再报"版本过低"。
  NVM_BEST=""
  NVM_BEST_KEY=-1
  for p in "$HOME/.nvm/versions/node"/*/bin; do
    [ -x "$p/node" ] || continue
    read -r v_maj v_min v_pat <<< "$(node_version_of "$p/node")"
    v_key=$(( ${v_maj:-0} * 1000000 + ${v_min:-0} * 1000 + ${v_pat:-0} ))
    if [ "$v_key" -gt "$NVM_BEST_KEY" ]; then
      NVM_BEST="$p"
      NVM_BEST_KEY="$v_key"
    fi
  done

  for p in \
    /opt/homebrew/bin \
    /usr/local/bin \
    "$NVM_BEST" \
    "$HOME/.volta/bin" \
    "$HOME/.fnm/aliases/default/bin"
  do
    [ -n "$p" ] || continue
    if [ -x "$p/node" ] && node_usable "$p/node"; then
      NODE_BIN="$p/node"
      export PATH="$p:$PATH"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then
    die_gui "Node 版本过低（当前 $(node -v 2>/dev/null)）。需要 22.13 或更新版本。
请升级：
  · 官网 https://nodejs.org（下载 LTS 版，双击安装）
  · 或终端执行：brew install node"
  fi
  die_gui "找不到 Node.js。
请先安装 Node 22.13 或更新版本：
  · 官网 https://nodejs.org（下载 LTS 版，双击安装）
  · 或终端执行：brew install node"
fi

echo "Node: $(node -v)  （${NODE_BIN}）"
echo

# ---- DSH_HOME：装配和启动必须用**同一个** ----
#
# ⚠️ 必须显式给 DSH_HOME（仓库内 .dsh-home），而且要在**调装配脚本之前**就定下来。
#    真机踩过：干净 shell 下不设它，dsh 会去读 ~/.dsh ——
#    那里没有我们的 profile（profile 是链到 .dsh-home/profiles/ 的），
#    于是报 "profile 不存在"，或者更糟：读到用户全局 dsh 的另一套配置。
#
#    早先是装配完才设：装配脚本会沿用环境里已有的 DSH_HOME，而启动用仓库内的 ——
#    环境里设过 DSH_HOME 的机器上，profile 链到一处、却从另一处启动。
DSH_HOME="$ROOT/.dsh-home"
export DSH_HOME

# ---- 装配（复用技术脚本，避免两份逻辑漂移）----
echo "检查环境…（首次运行需要几分钟，之后很快）"
echo
if ! bash "$ROOT/scripts/profile-mac.sh" "$PROFILE" --setup-only; then
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
#
# ⚠️ 必须带 --no-open：dsh 默认会**自己**开一次浏览器，下面抓到地址后又开一次，
#    每次启动都是两个标签页。开浏览器统一由本脚本做（抓到的地址带 token，
#    而且会打印出来，浏览器没弹出时还能手动复制）。
OPENED=0
"$ROOT/node_modules/.bin/dsh" --profile "$PROFILE" --port "$PORT" --no-open 2>&1 | while IFS= read -r line; do
  printf '%s\n' "$line"
  # dsh 打印形如：dsh web: http://127.0.0.1:3084/?token=xxxx
  case "$line" in
    *"dsh web: http"*)
      url="$(printf '%s' "$line" | sed -n 's/.*\(http[^ ]*\).*/\1/p')"
      # OPENED 活在管道右侧这个子 shell 里，循环内各次迭代共享 —— 只开一次就够了
      if [ -n "$url" ] && [ "$OPENED" = "0" ]; then
        OPENED=1
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
echo "按回车关闭…"
read -r _
