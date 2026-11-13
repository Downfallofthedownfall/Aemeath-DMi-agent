# ============================================================
# scripts/link-profile.ps1 — 把仓库里的 profile 接到 $DSH_HOME（Windows）
#
#   1) $DSH_HOME/profiles/<name>  → 仓库 profiles/<name>（junction）
#      不建这个的话 dsh 根本读不到这个 profile（dsh 只读 $DSH_HOME/profiles/）。
#   2) profiles/<name>/node_modules/@deepseek-ai → 仓库根 node_modules/@deepseek-ai
#      不建这个会出现两套模块实例（cordis 符号分裂 → 人格/工具调度异常）。
#   3) profiles/<name>/node_modules/@aemeath/<pkg> → 逐个 workspace 包
#      为什么逐个：包名（dsh-plugin-exercise）≠ 目录名（exercise），
#      把整个 packages/ 链成 @aemeath 会解析不到（比不链更糟）。
#
# 幂等：已存在且指向正确就跳过；指向别处就重建。
# 只建链接，不跑 npm install（profiles/* 里跑 npm install 会顺着
# @deepseek-ai junction 把仓库根依赖删空 —— 见 scripts/dsh.ps1 的告警）。
#
# 用法：
#   .\scripts\link-profile.ps1 -Profile exercise
#   .\scripts\link-profile.ps1 -Profile lecture,exercise,aemeath
# ============================================================
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string[]]$Profile,

  # 可选：DSH_HOME（缺省 = 仓库内 .dsh-home，与 dsh.ps1 一致）
  [string]$DshHome,

  # 被启动器调用时用：不打印结尾那句"接下来怎么启动"（启动器自己会启动）
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $DshHome) { $DshHome = Join-Path $root '.dsh-home' }
$dshProfiles = Join-Path $DshHome 'profiles'

function Ensure-Junction {
  # -KeepRealDirectory：目标位置若是**真实目录**（不是链接）就只告警、不替换。
  #   用在 $DSH_HOME/profiles/<name> 上 —— 那里的真实目录是一份 profile 副本，
  #   里面可能有只存在于副本里的改动（在界面里改过的配置就写在那儿）。
  #   本脚本现在会被启动器每次启动都调用，不能悄悄把它删了。
  #   node_modules 下的链接则照旧替换：真实目录只可能是误跑 npm install 留下的副本。
  param([string]$Path, [string]$Target, [string]$Label, [switch]$KeepRealDirectory)

  $full = [System.IO.Path]::GetFullPath($Path)
  if (Test-Path $full) {
    $item = Get-Item $full -Force
    $isLink = [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    # junction 和目录符号链接都算：指向对了就不动
    if ($isLink -and ([string]$item.Target).TrimEnd('\') -eq $Target.TrimEnd('\')) {
      Write-Host "  ✓ $Label 已就绪"
      return
    }
    if ($isLink) {
      Write-Host "  ↻ $Label 指向别处，重建"
      # 非递归删除 = 只摘掉链接本身，不碰它指向的目录
      [System.IO.Directory]::Delete($full, $false)
    } elseif ($KeepRealDirectory) {
      Write-Warning "  $Label 是真实目录而不是链接：dsh 读的是这份副本，在仓库里改 profile 不会生效。"
      Write-Warning "  确认里面没有要保留的改动后，删掉 $full 再重跑本脚本。"
      return
    } else {
      Write-Host "  ↻ $Label 是真实目录（误跑 npm install 留下的副本），替换为链接"
      Remove-Item $full -Recurse -Force
    }
  }
  New-Item -ItemType Junction -Path $full -Target $Target | Out-Null
  Write-Host "  + $Label → $Target"
}

if (-not (Test-Path $dshProfiles)) { New-Item -ItemType Directory -Path $dshProfiles -Force | Out-Null }

$deepseekTarget = Join-Path $root 'node_modules\@deepseek-ai'
$aeRoot = Join-Path $root 'node_modules\@aemeath'

foreach ($name in $Profile) {
  $src = Join-Path $root "profiles\$name"
  if (-not (Test-Path $src)) {
    Write-Warning "跳过 ${name}：仓库里没有 profiles\$name"
    continue
  }
  Write-Host "profile: $name"

  # 1) $DSH_HOME/profiles/<name> → 仓库（必须是链接：副本会让"改了不生效"）
  Ensure-Junction -Path (Join-Path $dshProfiles $name) -Target $src -Label "profiles/$name" -KeepRealDirectory

  # 2) @deepseek-ai 整目录链接
  $nm = Join-Path $src 'node_modules'
  if (-not (Test-Path $nm)) { New-Item -ItemType Directory -Path $nm -Force | Out-Null }
  if (Test-Path $deepseekTarget) {
    Ensure-Junction -Path (Join-Path $nm '@deepseek-ai') -Target $deepseekTarget -Label "$name/@deepseek-ai"
  } else {
    Write-Warning "  仓库根没有 node_modules\@deepseek-ai —— 先在仓库根 npm install"
  }

  # 3) @aemeath：从 profile 的 package.json 读依赖清单（避免手写清单漂移）
  $aeScope = Join-Path $nm '@aemeath'
  if (-not (Test-Path $aeScope)) { New-Item -ItemType Directory -Path $aeScope -Force | Out-Null }

  $pkgFile = Join-Path $src 'package.json'
  $deps = @()
  if (Test-Path $pkgFile) {
    $json = Get-Content $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($prop in $json.dependencies.PSObject.Properties) {
      if ($prop.Name -notlike '@aemeath/*') { continue }
      $m = [regex]::Match([string]$prop.Value, 'packages/(.+)$')
      if ($m.Success) { $deps += $m.Groups[1].Value }
    }
  }
  if (-not $deps.Count) { Write-Warning "  $name 的 package.json 里没有 @aemeath 依赖" }
  foreach ($rel in $deps) {
    $target = Join-Path (Join-Path $root 'packages') ($rel -replace '/', '\')
    $pkgName = Split-Path $rel -Leaf
    if (-not (Test-Path $target)) { Write-Warning "  找不到 $target，跳过"; continue }
    Ensure-Junction -Path (Join-Path $aeScope $pkgName) -Target $target -Label "$name/@aemeath/$pkgName"
  }
}
if (-not $Quiet) {
  Write-Host ''
  Write-Host "完成。启动：.\scripts\dsh.ps1 --profile $($Profile[0]) --port 3084"
}
