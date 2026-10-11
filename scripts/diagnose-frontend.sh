#!/usr/bin/env bash
# ============================================================
# 诊断课堂前端为什么"还是主 agent 的样子"
#
# 用法（在 mac 上，仓库根目录）：
#     bash scripts/diagnose-frontend.sh
#
# 它只**读**不写，跑完把输出整段发回来即可。
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/.."

echo "════════ 1) bundle 什么时候构建的？ ════════"
LIB="packages/lecture/dsh-plugin-lecture/lib/client.js"
if [[ -f "$LIB" ]]; then
  ls -l "$LIB" | awk '{print "  时间:", $6, $7, $8, " 大小:", $5}'
  echo "  当前时间: $(date '+%b %d %H:%M')"
else
  echo "  ✗ bundle 不存在！"
fi

echo
echo "════════ 2) bundle 里是新界面还是旧界面？ ════════"
if [[ -f "$LIB" ]]; then
  # 用标识符判断（中文会被 esbuild 转义成 \uXXXX，不能直接搜中文）
  for k in Workbench lec-wb-nav lec-wb-main lec-wb-side SymbolPanel LectureMode CapturePanel; do
    n=$(grep -o "$k" "$LIB" 2>/dev/null | wc -l | tr -d ' ')
    printf "  %-16s %s 次\n" "$k" "$n"
  done
  echo "  （期望：Workbench/lec-wb-* 有，LectureMode/CapturePanel 为 0）"
fi

echo
echo "════════ 3) dsh 实际读的是哪个文件？ ════════"
# profile 里的包必须是**链接**；若是副本，改了 packages/ 也不会生效
P="profiles/lecture/node_modules/@aemeath/dsh-plugin-lecture"
if [[ -L "$P" ]]; then
  echo "  ✓ $P 是链接 → $(readlink "$P")"
elif [[ -e "$P" ]]; then
  echo "  ✗ $P 是**真实目录副本**（不是链接）—— 这就是"改了没生效"的原因！"
else
  echo "  ? $P 不存在"
fi
if [[ -f "$P/lib/client.js" ]]; then
  ls -l "$P/lib/client.js" | awk '{print "  它读到的 client.js 时间:", $6, $7, $8}'
  for k in Workbench LectureMode; do
    n=$(grep -o "$k" "$P/lib/client.js" 2>/dev/null | wc -l | tr -d ' ')
    printf "    %-14s %s 次\n" "$k" "$n"
  done
fi

echo
echo "════════ 4) 服务在跑吗？是哪个进程？ ════════"
if command -v lsof >/dev/null 2>&1; then
  lsof -nP -iTCP:3083 -sTCP:LISTEN 2>/dev/null | tail -n +1 || echo "  3083 没人监听"
else
  echo "  （没有 lsof，跳过）"
fi

echo
echo "════════ 5) 服务端提供的 bundle 是新版吗？ ════════"
# 从正在跑的服务里抓 boot，看它引用的 rev
if curl -s --max-time 5 http://127.0.0.1:3083/ -o /tmp/aem-root.html 2>/dev/null; then
  echo "  能连上 3083"
  if grep -q 'aemeath/dsh-plugin-lecture/client.js' /tmp/aem-root.html; then
    echo "  ✓ boot 里引用了 lecture 的 client bundle"
    grep -o 'aemeath/dsh-plugin-lecture/client.js&rev=[a-f0-9]*' /tmp/aem-root.html | head -1 | sed 's/^/    /'
  else
    echo "  ✗ boot 里**没有** lecture 的 client bundle"
  fi
else
  echo "  连不上 3083（服务没在跑？）"
fi
rm -f /tmp/aem-root.html

echo
echo "════════ 6) 源码是不是比 bundle 新（该不该重建）════════"
SRC="packages/lecture/dsh-plugin-lecture/src/client"
if [[ -f "$LIB" && -d "$SRC" ]]; then
  newer="$(find "$SRC" -type f -newer "$LIB" -print -quit 2>/dev/null || true)"
  if [[ -n "$newer" ]]; then
    echo "  ⚠ 需要重建，较新的文件：$newer"
  else
    echo "  ✓ bundle 已是最新"
  fi
fi

echo
echo "════════ 7) 版本 ════════"
grep -m1 'LECTURE_MAC_VERSION=' scripts/lecture-mac.sh | sed 's/^/  /'
git log --oneline -1 2>/dev/null | sed 's/^/  当前提交: /'

echo
echo "════════ 完 ════════"
echo "把以上整段发回即可。"
