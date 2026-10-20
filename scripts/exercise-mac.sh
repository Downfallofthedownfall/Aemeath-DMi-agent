#!/usr/bin/env bash
# ============================================================
# scripts/exercise-mac.sh — 在 macOS 上跑「习题模式（Übungen）」
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
#   ./scripts/exercise-mac.sh              # 启动（默认 3084）
#   ./scripts/exercise-mac.sh --port 4000  # 换端口
#   ./scripts/exercise-mac.sh --setup-only # 只做装配，不启动
# ============================================================
set -euo pipefail

# 脚本版本戳：排查"你那边和我这边是不是同一份"时一眼可见。
# （真机踩过：报错行号对不上，无法判断是环境差异还是代码差异。）
EXERCISE_MAC_VERSION="2026-10-20.1"

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
PORT="${PORT:-3084}"
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

say()  { printf '\033[36m[exercise-mac]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[exercise-mac] ⚠ %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m[exercise-mac] ✗ %s\033[0m\n' "$*" >&2; exit 1; }

say "脚本版本 $EXERCISE_MAC_VERSION  ·  port=$PORT  ·  DSH_HOME=$DSH_HOME"

# ---- 0) 平台门禁 ----
# 本脚本靠符号链接把 profile 接到 ${DSH_HOME}。Windows 的 Git Bash 通常
# 造不出符号链接（除非开发者模式/管理员），`ln -s` 会**退化成复制**——
# 于是 DSH_HOME 里多出一份与仓库脱钩的副本，改了配置不生效且悄悄分叉。
# 与其静默降级，不如直接拒绝：Windows 请用 scripts\dsh.ps1。
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    die "检测到 Windows 的 bash（$(uname -s)）。
  在 Windows 上请用 PowerShell 脚本：
      .\\scripts\\dsh.ps1 --profile exercise --port 3084
  本脚本是给 macOS / Linux 用的（依赖符号链接）。"
    ;;
esac

# ---- 0) 前置检查：明确告诉用户缺什么，而不是抛一句 node 的错 ----
command -v node >/dev/null 2>&1 || die "找不到 node。请先装 Node.js 20+（https://nodejs.org 或 brew install node）"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node 版本过低（${NODE_MAJOR}）。需要 20+。"

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

# shell 可移植性自检：macOS 自带 bash 3.2 对 `$VAR` 紧跟非 ASCII 的写法
# 会把该字符的首字节吃进变量名（真机踩过：`$PORT）` → `PORT\xef: unbound variable`）。
# 这个检查在每次启动时跑一遍，代价可忽略，但能挡住整类问题。
say "检查 shell 可移植性…"
# 注意：下面的提示文字里**不要**写出「$VAR 紧跟全角括号」的实例，
# 否则会被这个检查自己抓到（检查器无法区分"示例"和"真实用法"）。
node "$ROOT/scripts/verify-shell-portability.mjs" || die "\
脚本里有变量引用后面紧跟非 ASCII 字符的写法，macOS 的 bash 3.2 会解析错。
  修复：给变量加花括号。例如把 port=\$PORT） 改成 port=\${PORT}）。"

# exercise 插件必须已构建（client bundle 是前端本体）。
#
# ⚠️ 关键：必须先构建**依赖**（@aemeath/dsh-plugin-common）。
#    它的类型声明在 lib/*.d.ts，而 **packages/**/lib/ 被 gitignore**
#    （.gitignore:198）—— 全新 clone 里根本不存在。
#    于是 tsc 编译 exercise 时会报：
#        src/index.ts:33 error TS2307: Cannot find module '@aemeath/dsh-plugin-common'
#    这条错看着像"链接缺失"，实际是"依赖没构建"，很容易误诊
#    （真机上我先按链接问题查了半天）。
#    所以这里用 `npm run build`（构建全部 workspace，按依赖顺序），
#    而不是只 build exercise。
COMMON_LIB="$ROOT/packages/shared/dsh-plugin-common/lib/index.d.ts"

# ⚠️⚠️ 真机踩过两次，都是"改了没生效"：
#
#   第一次：条件是"bundle **不存在**才构建"：
#       if [[ ! -f "$EXERCISE_LIB" ]]; then npm run build; fi
#     而 **packages/**/lib/ 被 gitignore** → `git pull` 只更新源码、不更新产物；
#     产物"已经存在"（旧版）→ **永远跳过构建**。
#
#   第二次（用户定位）：改成比对时间戳后，**却只比 client**：
#       find "$EXERCISE_SRC(client)" -newer "$EXERCISE_LIB(client.js)"
#     而那次修的是 **host**（src/index.ts → lib/index.js）——
#     client 没变 → 判断"不需要构建" → 跳过 → host 仍是旧的。
#     症状：源码里有 __AEMEATH_EXERCISE_STANDALONE__ 注入，
#           但 lib/index.js 里没有，页面也就没有那个标记。
#
#   所以现在**遍历所有 workspace 包**，对每个包同时比 host 与 client：
#       host:   src/**        vs  lib/index.js
#       client: src/client/** vs  lib/client.js
#   任一"源码比产物新"或"产物缺失" → 需要重建。
needs_build=0
if [[ ! -f "$COMMON_LIB" ]]; then
  # common 的 d.ts 是别的包的类型依赖，缺了必构建
  needs_build=1
else
  for pkg in "$ROOT"/packages/*/*; do
    [[ -f "$pkg/package.json" && -d "$pkg/src" ]] || continue

    # host 产物
    host_lib="$pkg/lib/index.js"
    if [[ ! -f "$host_lib" ]]; then
      needs_build=1
      break
    fi
    if [[ -n "$(find "$pkg/src" -type f -newer "$host_lib" -print -quit 2>/dev/null || true)" ]]; then
      needs_build=1
      break
    fi

    # client 产物（只有带 src/client 的包才有）
    if [[ -d "$pkg/src/client" ]]; then
      client_lib="$pkg/lib/client.js"
      if [[ ! -f "$client_lib" ]]; then
        needs_build=1
        break
      fi
      if [[ -n "$(find "$pkg/src/client" -type f -newer "$client_lib" -print -quit 2>/dev/null || true)" ]]; then
        needs_build=1
        break
      fi
    fi
  done
fi

if [[ "$needs_build" == "1" ]]; then
  say "构建 workspace（有源码比产物新，或产物缺失）…"
  npm run build || die "\
构建失败。
  若报 'Cannot find module @aemeath/dsh-plugin-common'，先确认依赖已构建：
      npm run build -w @aemeath/dsh-plugin-common
  若报 'Cannot find module @aemeath/...'（连包目录都找不到），那是链接问题：
      npm install        # 必须在仓库根，不要在 profiles/* 里
  详情见 docs/exercise-mode-plan.md 的 workspace 链接章节。"
fi

# ---- 2) 用符号链接把真实 profile 落到 $DSH_HOME/profiles/exercise ----
#
# ⚠️ 必须是真的符号链接。若环境不支持（Windows 无管理员权限时 bash 会退化成复制），
#    复制出来的 profile 与仓库脱钩：改了 cordis.patch.yml 不会生效，
#    而且两份配置会悄悄分叉。所以这里显式检查，不静默降级。
mkdir -p "$DSH_HOME/profiles"
LINK="$DSH_HOME/profiles/exercise"
SRC="$ROOT/profiles/exercise"
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
    die "无法创建符号链接 ${LINK}。
  macOS/Linux 上不该出现这个错误；若你在 Windows 的 Git Bash 里跑，
  请改用 scripts\\dsh.ps1（PowerShell 版）。"
  fi
  say "已链接 profile：$LINK → $SRC"
else
  say "profile 链接已存在：$LINK"
fi

# ---- 2.5) 校验 profile 一定是**链接**，不是副本 ----
#
# ⚠️ 这是真机上真正咬人的坑，而且有两层：
#
#   第一层：DSH 0.2.0 里 agent preset 是 **profile patch 里的一个插件条目**
#          （`@deepseek-ai/dsh-agent-preset`，见 dsh-web-app/presets/*.patch.yml），
#          **不是**扫 `$DSH_HOME/.agent-presets/` 目录 —— 那是 0.1.1 的机制，
#          0.2.0 的运行时里根本没有 ".agent-presets" 这个字符串。
#          所以早先"复制 preset 目录"的做法完全无效，却让人以为已经处理好了。
#
#   第二层（更隐蔽）：$DSH_HOME/profiles/<name> 若是**真实目录副本**而不是链接，
#          那么在仓库里改 profile **dsh 读不到**，它读的是那份旧副本。
#          症状：改了配置、重启了、还是老样子 —— 让人怀疑"是不是没生效"，
#          实际是"改的地方和读的地方不是同一个文件"。
#
# 所以这里强制校验：$DSH_HOME/profiles/exercise 必须是指向仓库的链接。
# 上面第 2 步已经建了链接；这里只做**确认**（万一被别的操作换成副本）。
if [[ -L "$LINK" ]]; then
  # 顺带确认 preset 声明真的在（防止 profile 内容被改坏）
  if ! grep -q 'dsh-agent-preset' "$SRC/cordis.patch.yml" 2>/dev/null; then
    warn "profile 里没有 @deepseek-ai/dsh-agent-preset 声明 ——"
    warn "  创建会话时会报 'Unknown agent preset: physicist'。"
    warn "  请检查 profiles/exercise/cordis.patch.yml 里的 preset-physicist 条目。"
  fi
else
  warn "$LINK 不是符号链接（可能是旧副本）——"
  warn "  在仓库里改 profile 将不会生效（dsh 读的是副本）。"
  warn "  修复：删除它后重跑本脚本。"
fi

# ---- 3) 关键：@deepseek-ai 与 @aemeath 都必须是指向仓库的链接 ----
# 这是 dsh.ps1 在 Windows 上做的事的 mac 等价物。
# 若 profile 里真有独立副本，会出现两套模块实例（见文件头 ②）。
#
# ⚠️ @aemeath 必须**逐包**链接：npm 按包名解析，
#    `@aemeath/dsh-plugin-exercise` 要指向 `packages/exercise/dsh-plugin-exercise`，
#    而 packages/ 下的目录名（exercise/、memory/…）并不等于包名。
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
  AE_PKGS=("shared/dsh-plugin-common" "exercise/dsh-plugin-exercise" "lecture/dsh-plugin-lecture")
fi

for rel in "${AE_PKGS[@]}"; do
  name="$(basename "$rel")"
  tgt="$ROOT/packages/$rel"
  if [[ ! -e "$tgt" ]]; then warn "找不到 ${tgt}，跳过"; continue; fi
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
#
# ⚠️ 真机踩过：用户明明在设置里填了 key，这里却报"没有找到凭据"。
#    原因是 `grep -q "deepseek"` **区分大小写**，而凭据文件里写的是
#    `DEEPSEEK_API_KEY`（全大写）→ 匹配不上 → 误报。
#    现在用 -i（忽略大小写），并同时认几种可能的写法。
CRED_FILE="$DSH_HOME/.credentials.yaml"
if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
  say "检测到 DEEPSEEK_API_KEY（环境变量）"
elif [[ -f "$CRED_FILE" ]] && grep -qiE 'deepseek' "$CRED_FILE" 2>/dev/null; then
  say "检测到 $CRED_FILE 中的 DeepSeek 凭据"
elif [[ -f "$CRED_FILE" ]] && grep -qiE 'api[_-]?key|token' "$CRED_FILE" 2>/dev/null; then
  # 有凭据但没写 deepseek 字样（例如只写 provider 名）——不武断说"没有"
  say "检测到 $CRED_FILE 中有凭据（未能确认是否为 DeepSeek）"
else
  warn "没有找到 DeepSeek 凭据 —— 「让爱弥斯检查」会不可用（导入 PDF、做题、生成提交 PDF 都照常）。"
  warn "设置方式（任一）："
  warn "  启动后点左下角「设置」→ Models 里填（推荐）"
  warn "  或 export DEEPSEEK_API_KEY=sk-xxxx     # 写进 ~/.zshrc 可持久"
  warn "  凭据文件位置：$CRED_FILE"
fi

if [[ "$SETUP_ONLY" == "1" ]]; then
  say "装配完成（--setup-only，未启动）。"
  exit 0
fi

# ---- 5) 启动 ----
DSH_BIN="$ROOT/node_modules/.bin/dsh"
[[ -x "$DSH_BIN" ]] || die "找不到 $DSH_BIN —— 请先在仓库根跑 npm install"

# ⚠️ 自检：真机上有过 `line 256: PORT?: unbound variable`，
#    报错行指向这里，但 PORT 早在开头就无条件赋值过、并且成功打印过。
#    bash 的报错格式是 `PORT: unbound variable`（**名字后面没有问号**），
#    所以 `PORT?` 这个写法说明脚本文件本身和预期不一致
#    （本地改动 / 换行符 / 编辑器插入的字符）。
#    与其继续猜，不如把关键变量的实际状态和文件指纹都打出来。
say "启动前自检："
say "  PORT=${PORT:-<未设置>}  SETUP_ONLY=${SETUP_ONLY:-<未设置>}  EXTRA_ARGS=${#EXTRA_ARGS[@]} 个"
say "  shell=$BASH_VERSION  （若为空说明不是 bash）"
say "  bash=$BASH  ·  uname=$(uname -s)"
# 文件指纹：比对"你跑的文件"和"git 里应有的文件"是否一致
SELF_SUM="$( (shasum -a 256 "$SCRIPT_PATH" 2>/dev/null || sha256sum "$SCRIPT_PATH" 2>/dev/null) | cut -c1-16 )"
say "  脚本指纹=$SELF_SUM  路径=$SCRIPT_PATH"
if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  GIT_SUM="$(git -C "$ROOT" show "HEAD:scripts/exercise-mac.sh" 2>/dev/null | (shasum -a 256 2>/dev/null || sha256sum 2>/dev/null) | cut -c1-16)"
  if [ -n "$GIT_SUM" ] && [ "$GIT_SUM" != "$SELF_SUM" ]; then
    warn "脚本与 git HEAD **不一致**（工作区=$SELF_SUM  HEAD=${GIT_SUM}）"
    warn "  你可能改过这个文件，或 git pull 没有完整更新。"
    warn "  建议：git status scripts/exercise-mac.sh   看差异；"
    warn "        git checkout -- scripts/exercise-mac.sh   还原成仓库版本"
  else
    say "  与 git HEAD 一致"
  fi
fi
if [[ -z "${PORT:-}" ]]; then
  die "PORT 在启动前丢失了——这是脚本 bug，请把上面这几行发给我。"
fi

say "启动习题模式（profile=exercise, port=${PORT}）"
say "浏览器会自动打开；没打开就手动访问终端里打印的带 token 的地址。"
echo
exec "$DSH_BIN" --profile exercise --port "$PORT" "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
