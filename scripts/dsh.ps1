# ============================================================
# scripts/dsh.ps1 — Aemeath v2 的 dsh 包装脚本
#   1) 固定 DSH_HOME = 仓库 .dsh-home（项目内隔离，不碰全局 web profile）
#   2) 固定 cwd = 仓库根（配置文件里的相对路径依赖它）
#   3) profile 还没接到 DSH_HOME 时，先把链接建好（scripts\link-profile.ps1）
#   4) 自动定位 dsh CLI（项目内 node_modules → npx 缓存 → PATH），
#      不依赖用户终端的 PATH 配置
# 用法：.\scripts\dsh.ps1 --profile aemeath --port 3081
#       .\scripts\dsh.ps1 --profile aemeath-run "问题"
#
# ⚠️ 本文件必须带 UTF-8 BOM（与其它 .ps1 一致）：Windows PowerShell 5.1 把没有 BOM
#    的脚本按系统 ANSI 代码页读，里面的中文提示会变成乱码。
# ============================================================

# —— 1) 解析脚本所在目录（多级兜底，兼容 -File / 后台 / 沙箱 / 嵌套调用）——
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $PSCommandPath }
if (-not $scriptDir -and $MyInvocation) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
$root = Split-Path -Parent $scriptDir
$env:DSH_HOME = Join-Path $root '.dsh-home'

# —— 2) profile 还没接到 DSH_HOME 时先建链接 ——
# dsh 只从 $DSH_HOME\profiles\<name> 找 profile，**不读**仓库里的 profiles\。
# 链接缺失（新克隆的机器 / 新加的 profile）时不补上，dsh 直接报
#     profile "exercise" does not exist
# 只在链接**不存在**时才动手：已经接好的环境完全不碰（修复仍由下面 3.5 负责）。
#
# （这里原先是"同步 agent presets 到 .dsh-home\.agent-presets"。那是 DSH 0.1.1 的
#   机制：0.2.x 的 preset 是 profile patch 里的 `@deepseek-ai/dsh-agent-preset` 条目，
#   运行时和本仓库里都已经没有任何东西读那个目录，所以这一步删掉了。）
$profileName = $null
for ($i = 0; $i -lt $args.Count; $i++) {
  $a = [string]$args[$i]
  if ($a -eq '--profile' -and ($i + 1) -lt $args.Count) { $profileName = [string]$args[$i + 1]; break }
  if ($a -like '--profile=*') { $profileName = $a.Substring('--profile='.Length); break }
}
if ($profileName -and $profileName -match '^[A-Za-z0-9._-]+$') {
  $repoProfile = Join-Path $root "profiles\$profileName"
  $homeProfile = Join-Path $env:DSH_HOME "profiles\$profileName"
  if ((Test-Path $repoProfile) -and -not (Test-Path $homeProfile)) {
    Write-Host "[dsh.ps1] profile '$profileName' 还没接到 DSH_HOME，现在建立链接"
    try {
      & (Join-Path $scriptDir 'link-profile.ps1') -Profile $profileName -Quiet
    } catch {
      Write-Warning "[dsh.ps1] 建立 profile 链接失败：$($_.Exception.Message)"
    }
  }
}

# —— 3) 定位 dsh CLI：项目内 → npx 缓存 → PATH（C10：npx 缓存可能命中其他项目
#    的旧版 dsh，逐一校验版本号后才采用）——
$expectedDshVersion = '0.2.1-rc.2'

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
  Write-Error "[dsh.ps1] 找不到匹配版本（$expectedDshVersion）的 dsh CLI。请先执行: npm install --save-dev @deepseek-ai/dsh@0.2.1-rc.2"
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

# —— ⚠ 关键防护：profile 的 @deepseek-ai 是「junction → 仓库根 node_modules」——
# 若在任何 profiles/*/ 目录里执行 `npm install`，npm 的 reify 会顺着该 junction
# 把仓库根 node_modules/@deepseek-ai 的内容删空（本会话已多次踩坑，需 `npm install`
# 恢复根）。因此：依赖安装/升级一律只在仓库根目录跑；profiles 只需通过本 junction
# 与根保持同步，其 package-lock.json 可单独用 `npm install --package-lock-only`
# 更新（不 reify、不碰 junction、安全）。
Write-Host "[dsh.ps1] 提示：本 profile 的 @deepseek-ai 为 junction→仓库根；请勿在 profiles/* 内运行 npm install（会清空根目录依赖，只在仓库根安装）"

Push-Location $root
& $dshBin @args
$code = $LASTEXITCODE
Pop-Location
exit $code
