# ============================================================
# scripts/dsh.ps1 — Aemeath v2 的 dsh 包装脚本
#   1) 固定 DSH_HOME = 仓库 .dsh-home（项目内隔离，不碰全局 web profile）
#   2) 固定 cwd = 仓库根（配置文件里的相对路径依赖它）
#   3) 同步 agent presets（profiles/aemeath/agent-presets/ → .dsh-home/.agent-presets/，
#      dsh-agent-presets 的 includeUserRoot 默认扫描该目录，user trust）
#   4) 自动定位 dsh CLI（项目内 node_modules → npx 缓存 → PATH），
#      不依赖用户终端的 PATH 配置
# 用法：.\scripts\dsh.ps1 --profile aemeath --port 3081
#       .\scripts\dsh.ps1 --profile aemeath-run "问题"
# ============================================================

# —— 1) 解析脚本所在目录（多级兜底，兼容 -File / 后台 / 沙箱 / 嵌套调用）——
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $PSCommandPath }
if (-not $scriptDir -and $MyInvocation) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
$root = Split-Path -Parent $scriptDir
$env:DSH_HOME = Join-Path $root '.dsh-home'

# —— 2) 同步 agent presets（先删旧再复制，保证与 git 内容一致）——
$srcPresets = Join-Path $root 'profiles\aemeath\agent-presets'
$dstPresets = Join-Path $env:DSH_HOME '.agent-presets'
if (Test-Path $srcPresets) {
  if (Test-Path $dstPresets) { Remove-Item $dstPresets -Recurse -Force -ErrorAction SilentlyContinue }
  Copy-Item $srcPresets $dstPresets -Recurse -Force -ErrorAction Stop
  Write-Host "[dsh.ps1] agent presets 已同步: $((Get-ChildItem $dstPresets -Directory | ForEach-Object { $_.Name }) -join ', ')"
} else {
  Write-Warning "[dsh.ps1] agent presets 源目录不存在: $srcPresets（跳过同步）"
}

# —— 3) 定位 dsh CLI：项目内 → npx 缓存 → PATH（C10：npx 缓存可能命中其他项目
#    的旧版 dsh，逐一校验版本号后才采用）——
$expectedDshVersion = '0.1.0-rc.6'

function Test-DshCliVersion {
  param([string]$bin)
  if (-not (Test-Path $bin)) { return $false }
  try {
    # 注意：.cmd shim 经 PowerShell 调用时 $LASTEXITCODE 可能是 -1（cmd 语义），
    # 不能据此判失败；以版本字符串精确匹配为准。
    $ver = (& $bin --version 2>$null | Select-Object -First 1)
    return ([string]$ver).Trim() -eq $expectedDshVersion
  } catch {
    return $false
  }
}

function Find-DshCli {
  # a) 项目内 node_modules（npm install 后固定可用；仍校验版本，防装错版本）
  $local = Join-Path $root 'node_modules\.bin\dsh.cmd'
  if ((Test-Path $local) -and (Test-DshCliVersion $local)) { return $local }
  # b) npx 缓存（_npx/<hash>/node_modules/.bin/dsh.cmd）——校验版本，避免选到
  #    其他项目的旧版 dsh
  $npxBase = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
  if (Test-Path $npxBase) {
    foreach ($dir in Get-ChildItem $npxBase -Directory -ErrorAction SilentlyContinue) {
      $candidate = Join-Path $dir.FullName 'node_modules\.bin\dsh.cmd'
      if ((Test-Path $candidate) -and (Test-DshCliVersion $candidate)) { return $candidate }
    }
  }
  # c) PATH
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($cmd -and (Test-DshCliVersion $cmd.Source)) { return $cmd.Source }
  return $null
}

$dshBin = Find-DshCli
if (-not $dshBin) {
  Write-Error "[dsh.ps1] 找不到匹配版本（$expectedDshVersion）的 dsh CLI。请先执行: npm install --save-dev @deepseek-ai/dsh@0.1.0-rc.6"
  exit 1
}
Write-Host "[dsh.ps1] 使用 dsh: $dshBin"

# —— 3.5) 修复 profile 的 @deepseek-ai 双份依赖（关键坑）——
# profile 目录 npm install 会把 @deepseek-ai/* 装成独立副本，与项目根 node_modules
# 形成两套模块实例：cordis/dsh-scope/dsh-tools 的私有 Symbol（kScope、
# TOOL_RUNTIME_SCHEDULER）对不上 → agent scope 判定失效（全落全局层，人格冲突/
# 课程上下文全局化）+ 工具调度器缺失（Cannot read properties of undefined
# (reading 'prepare')）。把 profile 的 @deepseek-ai 替换为 junction → 项目根，
# 与 .dsh-home/profiles/node_modules 同款做法，保证单实例。
$profilesDir = Join-Path $env:DSH_HOME 'profiles'
if (Test-Path $profilesDir) {
  foreach ($profileDir in Get-ChildItem $profilesDir -Directory) {
    $profDeepseek = Join-Path $profileDir.FullName 'node_modules\@deepseek-ai'
    if (Test-Path $profDeepseek) {
      $item = Get-Item $profDeepseek
      $isJunction = $item.LinkType -eq 'Junction' -and $item.Target -eq (Join-Path $root 'node_modules\@deepseek-ai')
      if (-not $isJunction) {
        Remove-Item $profDeepseek -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Junction -Path $profDeepseek -Target (Join-Path $root 'node_modules\@deepseek-ai') -ErrorAction Stop | Out-Null
        Write-Host "[dsh.ps1] 已修复 $($profileDir.Name) 的 @deepseek-ai → junction（消除双份依赖）"
      }
    }
  }
}

Push-Location $root
& $dshBin @args
$code = $LASTEXITCODE
Pop-Location
exit $code
