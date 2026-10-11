#!/usr/bin/env bash
# ============================================================
# scripts/lecture-mac.sh — 在 macOS 上跑「课堂记录模式」
#
# 为什么需要这个脚本：dsh 的 profile 有两个非显然的坑，
# 在 Windows 上由 scripts/dsh.ps1 处理，mac 上没有对应的东西：
#
#   ① profile 必须落在 $DSH_HOME/profiles/<name>/
#      —— dsh **不读**仓库里的 profiles/ 目录。
#      Windows 用 junction，mac 用符号链接。
#
#   ② profile 的 @deepseek-ai 必须是**指向仓库根 node_modules 的链接**
#      —— 若让 npm 在 profile 里装一份独立副本，会出现两套模块实例，
#      cordis 的私有 Symbol 对不上 → agent scope 判定失效 + 工具调度器缺失。
#      ⚠️ 所以**永远不要**在 profiles/* 里跑 npm install
#         （npm 的 reify 会顺着链接把仓库根依赖删空）。
#
# 用法：
#   ./scripts/lecture-mac.sh              # 启动（默认 3083）
#   ./scripts/lecture-mac.sh --port 4000  # 换端口
#   ./scripts/lecture-mac.sh --setup-only # 只做装配，不启动
# ============================================================
set -euo pipefail

# 脚本版本戳：排查"你那边和我这边是不是同一份"时一眼可见。
# （真机踩过：报错行号对不上，无法判断是环境差异还是代码差异。）
LECTURE_MAC_VERSION="2026-10-12.2"

# ---- 路径 ----
# ⚠️ 用 BASH_SOURCE 定位脚本自身，再取上一级作为仓库根。
#    支持被 source / 被 bash 调用 / 直接执行三种方式。
SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
ROOT="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
cd "$ROOT"

DSH_HOME="${DSH_HOME:-$ROOT/.dsh-home}"
export DSH_HOME

# ---- 参数 ----
# ⚠️ 真机踩过：报 `line 235: PORT: unbound variable`。
#    第 235 行只是**第一个用到 PORT 的地方**，赋值在更上面；
#    在 set -u 下一旦那个赋值没生效，错误就报在后面，指向误导性的行号。
#    所以这里：
#      ① 用 :- 兜底（即使前面的赋值因为任何原因没跑到，也不会 unbound）
#      ② 解析参数时校验 --port 后面确实有值（`--port` 裸着用会让 $2 报 unbound）
PORT="${PORT:-3083}"
SETUP_ONLY="${SETUP_ONLY:-0}"
EXTRA_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      if [[ -z "${2:-}" ]]; then
        echo "✗ --port 后面需要跟一个端口号，例如 --port 4000" >&2
        exit 2
      fi
      PORT="$2"; shift 2 ;;
    --setup-only) SETUP_ONLY=1; shift ;;
    *) EXTRA_ARGS+=("$1"); shift ;;
  esac
done

say()  { printf '\033[36m[lecture-mac]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[lecture-mac] ⚠ %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m[lecture-mac] ✗ %s\033[0m\n' "$*" >&2; exit 1; }

say "脚本版本 $LECTURE_MAC_VERSION  ·  port=$PORT  ·  DSH_HOME=$DSH_HOME"

# ---- 0) 平台门禁 ----
# 本脚本靠符号链接把 profile 接到 $DSH_HOME。Windows 的 Git Bash 通常
# 造不出符号链接（除非开发者模式/管理员），`ln -s` 会**退化成复制**——
# 于是 DSH_HOME 里多出一份与仓库脱钩的副本，改了配置不生效且悄悄分叉。
# 与其静默降级，不如直接拒绝：Windows 请用 scripts\dsh.ps1。
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    die "检测到 Windows 的 bash（$(uname -s)）。
  在 Windows 上请用 PowerShell 脚本：
      .\\scripts\\dsh.ps1 --profile lecture --port 3083
  本脚本是给 macOS / Linux 用的（依赖符号链接）。"
    ;;
esac

# ---- 0) 前置检查：明确告诉用户缺什么，而不是抛一句 node 的错 ----
command -v node >/dev/null 2>&1 || die "找不到 node。请先装 Node.js 20+（https://nodejs.org 或 brew install node）"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node 版本过低（$NODE_MAJOR）。需要 20+。"

# ---- 1) 依赖 ----
if [[ ! -d "$ROOT/node_modules/@deepseek-ai/dsh" ]]; then
  say "首次运行：安装仓库依赖（只在仓库根安装）…"
  npm install || die "npm install 失败。请检查网络或代理后重试。"
fi

# 关键：workspace 的 @aemeath/* 链接必须可解析。
# 它们的**声明**在根 package.json（devDependencies），由 npm install 建立链接。
# 若这里失败，后面构建会报一串看不懂的 TS2307 —— 与其让用户猜，
# 不如在这里用一句能懂的话拦住（真机踩过：全新 clone 到 mac 必挂）。
say "检查 workspace 链接…"
node "$ROOT/scripts/verify-workspace-links.mjs" || die "\
workspace 链接缺失（@aemeath/* 无法解析）。
  这会让构建报 'Cannot find module @aemeath/dsh-plugin-common' 之类的错。
  修复：在仓库根执行 npm install（不要在 profiles/* 里装依赖）。"

# lecture 插件必须已构建（client bundle 是前端本体）。
#
# ⚠️ 关键：必须先构建**依赖**（@aemeath/dsh-plugin-common）。
#    它的类型声明在 lib/*.d.ts，而 **packages/**/lib/ 被 gitignore**
#    （.gitignore:198）—— 全新 clone 里根本不存在。
#    于是 tsc 编译 lecture 时会报：
#        src/index.ts:33 error TS2307: Cannot find module '@aemeath/dsh-plugin-common'
#    这条错看着像"链接缺失"，实际是"依赖没构建"，很容易误诊
#    （真机上我先按链接问题查了半天）。
#    所以这里用 `npm run build`（构建全部 workspace，按依赖顺序），
#    而不是只 build lecture。
COMMON_LIB="$ROOT/packages/shared/dsh-plugin-common/lib/index.d.ts"
LECTURE_LIB="$ROOT/packages/lecture/dsh-plugin-lecture/lib/client.js"
if [[ ! -f "$COMMON_LIB" || ! -f "$LECTURE_LIB" ]]; then
  say "构建 workspace（含 lecture 的依赖 —— 类型声明是构建产物，不在 git 里）…"
  npm run build || die "\
构建失败。
  若报 'Cannot find module @aemeath/dsh-plugin-common'，先确认依赖已构建：
      npm run build -w @aemeath/dsh-plugin-common
  若报 'Cannot find module @aemeath/...'（连包目录都找不到），那是链接问题：
      npm install        # 必须在仓库根，不要在 profiles/* 里
  详情见 docs/lecture-devlog.md 的 workspace 链接章节。"
fi

# ---- 2) 用符号链接把真实 profile 落到 $DSH_HOME/profiles/lecture ----
#
# ⚠️ 必须是真的符号链接。若环境不支持（Windows 无管理员权限时 bash 会退化成复制），
#    复制出来的 profile 与仓库脱钩：改了 cordis.patch.yml 不会生效，
#    而且两份配置会悄悄分叉。所以这里显式检查，不静默降级。
mkdir -p "$DSH_HOME/profiles"
LINK="$DSH_HOME/profiles/lecture"
SRC="$ROOT/profiles/lecture"
if [[ -L "$LINK" ]]; then
  # 已是链接：确认指向正确（换过仓库位置的话要重建）
  if [[ "$(readlink "$LINK")" != "$SRC" ]]; then
    warn "profile 链接指向别处，重建：$(readlink "$LINK") → $SRC"
    rm "$LINK"
  fi
fi
if [[ ! -e "$LINK" && ! -L "$LINK" ]]; then
  ln -s "$SRC" "$LINK" 2>/dev/null || true
  if [[ ! -L "$LINK" ]]; then
    # 链接没建成：绝不留下一个复制品冒充链接
    [[ -e "$LINK" ]] && rm -rf "$LINK"
    die "无法创建符号链接 $LINK。
  macOS/Linux 上不该出现这个错误；若你在 Windows 的 Git Bash 里跑，
  请改用 scripts\\dsh.ps1（PowerShell 版）。"
  fi
  say "已链接 profile：$LINK → $SRC"
else
  say "profile 链接已存在：$LINK"
fi

# ---- 3) 关键：@deepseek-ai 与 @aemeath 都必须是指向仓库的链接 ----
# 这是 dsh.ps1 在 Windows 上做的事的 mac 等价物。
# 若 profile 里真有独立副本，会出现两套模块实例（见文件头 ②）。
#
# ⚠️ @aemeath 必须**逐包**链接：npm 按包名解析，
#    `@aemeath/dsh-plugin-lecture` 要指向 `packages/lecture/dsh-plugin-lecture`，
#    而 packages/ 下的目录名（lecture/、memory/…）并不等于包名。
#    早先的写法把整个 packages/ 链成 @aemeath，会让 @aemeath/memory 解析到
#    packages/memory（缺 dsh-plugin- 前缀）—— 链接存在但解析不到，比不链更糟。
PROFILE_NM="$SRC/node_modules"
mkdir -p "$PROFILE_NM"

# 3a) @deepseek-ai：整目录链接（包名与目录名一致）
DEEPSEEK_LINK="$PROFILE_NM/@deepseek-ai"
DEEPSEEK_SRC="$ROOT/node_modules/@deepseek-ai"
if [[ -L "$DEEPSEEK_LINK" ]]; then
  [[ "$(readlink "$DEEPSEEK_LINK")" == "$DEEPSEEK_SRC" ]] || { rm "$DEEPSEEK_LINK"; ln -s "$DEEPSEEK_SRC" "$DEEPSEEK_LINK"; say "重建 @deepseek-ai 链接"; }
elif [[ -e "$DEEPSEEK_LINK" ]]; then
  warn "@deepseek-ai 是真实目录（之前误跑 npm install 留下的）——替换为链接（这正是模块实例重复的根因）"
  rm -rf "$DEEPSEEK_LINK"
fi
[[ -L "$DEEPSEEK_LINK" ]] || { [[ -e "$DEEPSEEK_SRC" ]] && ln -s "$DEEPSEEK_SRC" "$DEEPSEEK_LINK" && say "已链接 dsh 栈：@deepseek-ai"; }

# 3b) @aemeath：逐包链接（目录名 ≠ 包名）
AE_SCOPE="$PROFILE_NM/@aemeath"
if [[ -L "$AE_SCOPE" ]]; then
  rm "$AE_SCOPE"   # 早先误把整个 packages/ 链在这里，清掉
elif [[ -e "$AE_SCOPE" ]]; then
  # 真实目录：可能是误跑 npm install 留下的独立副本（模块实例重复的根因）。
  # 整个删掉重建，不在旧内容上叠加——否则会残留上一次的包，
  # 让"依赖清单"与实际链接悄悄分叉。
  warn "@aemeath 是真实目录（之前误跑 npm install 留下的）——删除并改为逐包链接"
  rm -rf "$AE_SCOPE"
fi
mkdir -p "$AE_SCOPE"

# profile 依赖里声明的 @aemeath 包 —— 从 package.json 读，避免手写清单漂移
AE_PKGS=()
if [[ -f "$SRC/package.json" ]]; then
  while IFS= read -r dep; do
    [[ -n "$dep" ]] && AE_PKGS+=("$dep")
  done < <(node -e '
    const p = require(process.argv[1]);
    const d = p.dependencies || {};
    for (const k of Object.keys(d)) {
      if (!k.startsWith("@aemeath/")) continue;
      // file:../../packages/<area>/<pkg> → <area>/<pkg>
      const m = String(d[k]).match(/packages\/(.+)$/);
      if (m) console.log(m[1]);
    }
  ' "$SRC/package.json" 2>/dev/null || true)
fi

if [[ ${#AE_PKGS[@]} -eq 0 ]]; then
  warn "没能从 package.json 解析出 @aemeath 依赖，退回内置清单"
  AE_PKGS=("shared/dsh-plugin-common" "lecture/dsh-plugin-lecture")
fi

for rel in "${AE_PKGS[@]}"; do
  name="$(basename "$rel")"
  tgt="$ROOT/packages/$rel"
  if [[ ! -e "$tgt" ]]; then warn "找不到 $tgt，跳过"; continue; fi
  ln -sfn "$tgt" "$AE_SCOPE/$name"
done

# 清掉清单之外的残留链接（依赖被移除后不该继续挂着）
for existing in "$AE_SCOPE"/*; do
  [[ -e "$existing" || -L "$existing" ]] || continue
  keep=0
  for rel in "${AE_PKGS[@]}"; do
    [[ "$(basename "$existing")" == "$(basename "$rel")" ]] && keep=1 && break
  done
  if [[ "$keep" == "0" ]]; then
    warn "移除清单外的残留链接：$(basename "$existing")"
    rm -rf "$existing"
  fi
done
say "@aemeath 逐包链接：$(ls "$AE_SCOPE" 2>/dev/null | tr '\n' ' ')"

# ---- 4) API key 检查（不打印内容）----
if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
  say "检测到 DEEPSEEK_API_KEY（环境变量）"
elif [[ -f "$DSH_HOME/.credentials.yaml" ]] && grep -q "deepseek" "$DSH_HOME/.credentials.yaml" 2>/dev/null; then
  say "检测到 $DSH_HOME/.credentials.yaml 中的凭据"
else
  warn "没有找到 DeepSeek 凭据 —— 课堂内的 LLM 转录会不可用（速记仍能记，只是不做规范化加工）。"
  warn "设置方式（任一）："
  warn "  export DEEPSEEK_API_KEY=sk-xxxx        # 写进 ~/.zshrc 可持久"
  warn "  或在 dsh 的设置里配置 provider 凭据"
fi

if [[ "$SETUP_ONLY" == "1" ]]; then
  say "装配完成（--setup-only，未启动）。"
  exit 0
fi

# ---- 5) 启动 ----
DSH_BIN="$ROOT/node_modules/.bin/dsh"
[[ -x "$DSH_BIN" ]] || die "找不到 $DSH_BIN —— 请先在仓库根跑 npm install"

say "启动课堂记录模式（profile=lecture, port=$PORT）"
say "浏览器会自动打开；没打开就手动访问终端里打印的带 token 的地址。"
echo
exec "$DSH_BIN" --profile lecture --port "$PORT" "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
