# ============================================================
# scripts/dsh.ps1 — Aemeath v2 的 dsh 包装脚本
#   1) 固定 DSH_HOME = 仓库 .dsh-home（项目内隔离，不碰全局 web profile）
#   2) 固定 cwd = 仓库根（配置文件里的相对路径依赖它）
#   3) 同步 agent presets（profiles/aemeath/agent-presets/ → .dsh-home/.agent-presets/，
#      dsh-agent-presets 的 includeUserRoot 默认扫描该目录，user trust）
# 用法：.\scripts\dsh.ps1 --profile aemeath --dump-config
#       .\scripts\dsh.ps1 --profile aemeath --port 3081
# ============================================================
# 兼容后台/沙箱执行：$PSScriptRoot 优先，其次 $PSCommandPath，最后调用者目录
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $PSCommandPath }
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
$root = Split-Path -Parent $scriptDir
$env:DSH_HOME = Join-Path $root '.dsh-home'

# —— 同步 agent presets（先删旧再复制，保证与 git 内容一致）——
$srcPresets = Join-Path $root 'profiles\aemeath\agent-presets'
$dstPresets = Join-Path $env:DSH_HOME '.agent-presets'
if (Test-Path $srcPresets) {
  if (Test-Path $dstPresets) { Remove-Item $dstPresets -Recurse -Force -ErrorAction SilentlyContinue }
  Copy-Item $srcPresets $dstPresets -Recurse -Force -ErrorAction Stop
  Write-Host "[dsh.ps1] agent presets 已同步: $(Get-ChildItem $dstPresets -Directory | ForEach-Object { $_.Name }) -join ', '"
}

Push-Location $root
& dsh @args
$code = $LASTEXITCODE
Pop-Location
exit $code
