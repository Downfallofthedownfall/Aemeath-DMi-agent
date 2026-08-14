# ============================================================
# scripts/dsh.ps1 — Aemeath v2 的 dsh 包装脚本
#   1) 固定 DSH_HOME = 仓库 .dsh-home（项目内隔离，不碰全局 web profile）
#   2) 固定 cwd = 仓库根（配置文件里的相对路径依赖它）
# 用法：.\scripts\dsh.ps1 --profile aemeath --dump-config
#       .\scripts\dsh.ps1 --profile aemeath-run "hi"
# ============================================================
$root = Split-Path -Parent $PSScriptRoot
$env:DSH_HOME = Join-Path $root '.dsh-home'
Push-Location $root
& dsh @args
$code = $LASTEXITCODE
Pop-Location
exit $code
