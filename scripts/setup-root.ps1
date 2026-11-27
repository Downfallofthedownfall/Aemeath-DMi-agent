# ============================================================
# scripts/setup-root.ps1 — setup.bat 的仓库根步骤：在装配锁里装依赖 / 构建
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-root.ps1 -Step install
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-root.ps1 -Step build
#
# 为什么要经这里，而不是在 setup.bat 里直接 npm install：
#   课堂 / 习题启动器（launch-profile.ps1）也会在仓库根 npm install / npm run build；
#   两边同时改 node_modules 会把它弄坏（见 setup-lock.ps1 文件头）。批处理拿不到
#   具名 Mutex，所以这两步交给 PowerShell，和启动器共用同一把装配锁。
#
# 不再用 --legacy-peer-deps（早先 setup.bat 带着它，DSH 0.2.0 时严格解析会 ERESOLVE）：
#   dsh 0.2.2 起普通 npm install 就能装；而带着它装会删掉只作为 peer 出现的
#   @deepseek-ai/dsh-error，启动器的 check-deps 随即判"缺包"、又整套重装一遍 ——
#   两边对 node_modules 的看法必须一致。
# 退出码 = npm / check-deps 的退出码（setup.bat 据此报 [FAIL]）。
# ============================================================
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('install', 'build')]
  [string]$Step
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
. (Join-Path $PSScriptRoot 'setup-lock.ps1')

Enter-SetupLock
if ($Step -eq 'install') {
  & npm install --cache .npm-cache
  $code = $LASTEXITCODE
  if ($code -eq 0) {
    # 装完核对一遍：和启动器用的是同一个判据
    & node "$root\scripts\check-deps.mjs"
    $code = $LASTEXITCODE
  }
} else {
  & npm run build
  $code = $LASTEXITCODE
}
Exit-SetupLock
exit $code
