# ============================================================
# 课堂记录.ps1 — 双击启动（Windows）
#
# 双击「课堂记录.bat」会调到这里。
# 做三件事：装配检查 → 启动 → 就绪后自动开浏览器。
#
# 与 mac 的 课堂记录.command 对应，体验保持一致。
# ============================================================
param(
  [int]$Port = 3083,
  [switch]$SetupOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Die($msg) {
  Write-Host ""
  Write-Host "✗ $msg" -ForegroundColor Red
  Write-Host ""
  Write-Host "按回车关闭…" -ForegroundColor DarkGray
  [void](Read-Host)
  exit 1
}

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Aemeath 课堂记录模式" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ---- Node 检查 ----
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Die "找不到 Node.js。请先安装 Node 20+（https://nodejs.org），装完重开这个窗口。"
}
# ⚠️ 不要用 `node -p 'process.versions.node.split(".")[0]'`：
#    PowerShell 会把内层双引号吃掉，node 收到 split(.)[0] → SyntaxError。
#    直接解析 node -v 的输出，零引号嵌套。
$nodeVer = (& node -v) -replace '^v', ''
$major = [int]($nodeVer -split '\.')[0]
if ($major -lt 20) {
  Die "Node 版本过低（当前 $nodeVer）。需要 20 或更新版本。"
}
Write-Host "Node: v$nodeVer" -ForegroundColor DarkGray
Write-Host ""

# ---- 装配（复用 dsh.ps1 的既有逻辑，避免两份漂移）----
if (-not (Test-Path "$root\node_modules\.bin\dsh.cmd")) {
  Write-Host "首次运行：安装依赖…（需要几分钟）" -ForegroundColor Yellow
  & npm install
  if ($LASTEXITCODE -ne 0) { Die "npm install 失败。" }
}

if (-not (Test-Path "$root\packages\lecture\dsh-plugin-lecture\lib\client.js")) {
  Write-Host "构建插件…" -ForegroundColor Yellow
  & npm run build
  if ($LASTEXITCODE -ne 0) { Die "构建失败。详见上方输出。" }
}

# ---- 同步 agent presets（关键！）----
# dsh 的 agent preset 不在 profile 里，而在 $DSH_HOME\.agent-presets\。
# 不复制过去，profile 里的 `default: physicist` 就指不到东西，创建会话时报：
#     agent-preset/not-found: Unknown agent preset: physicist
#
# dsh.ps1 会做这件事，但本启动器**直接调 dsh.cmd**（为了自己抓 token URL），
# 绕过了 dsh.ps1 —— 所以必须在这里补上。真机踩过。
$presetSrc = "$root\profiles\aemeath\agent-presets"
$presetDst = "$root\.dsh-home\.agent-presets"
if (Test-Path $presetSrc) {
  if (Test-Path $presetDst) { Remove-Item $presetDst -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Path $presetDst -Force | Out-Null
  Copy-Item "$presetSrc\*" $presetDst -Recurse -Force
  $names = (Get-ChildItem $presetDst -Directory | ForEach-Object { $_.Name }) -join ', '
  Write-Host "agent presets 已同步：$names" -ForegroundColor DarkGray
} else {
  Write-Warning "找不到 agent presets 源目录：$presetSrc"
  Write-Warning "创建会话时可能报 'Unknown agent preset: physicist'。"
}
Write-Host ""

if ($SetupOnly) {
  Write-Host "装配完成（-SetupOnly，未启动）。" -ForegroundColor Green
  exit 0
}

Write-Host "--------------------------------------------" -ForegroundColor DarkGray
Write-Host " 正在启动…浏览器会自动打开" -ForegroundColor Green
Write-Host "--------------------------------------------" -ForegroundColor DarkGray
Write-Host " · 这个窗口*不要关*（关了服务就停了）" -ForegroundColor DarkGray
Write-Host " · 要停止：关掉窗口，或按 Ctrl+C" -ForegroundColor DarkGray
Write-Host ""

# ---- 启动并把带 token 的地址开进浏览器 ----
# dsh 自己也会开浏览器；这里额外抓一遍地址，保证用户一定拿得到。
$env:DSH_HOME = "$root\.dsh-home"
$dsh = "$root\node_modules\.bin\dsh.cmd"

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $dsh
$psi.Arguments = "--profile lecture --port $Port"
$psi.WorkingDirectory = $root
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.StandardOutputEncoding = [Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [Text.Encoding]::UTF8
$psi.EnvironmentVariables['DSH_HOME'] = $env:DSH_HOME

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
$opened = $false

$handler = {
  if (-not $EventArgs.Data) { return }
  $line = $EventArgs.Data
  Write-Host $line
  if (-not $script:opened -and $line -match 'dsh web:\s+(http\S+)') {
    $script:opened = $true
    $url = $Matches[1]
    Write-Host ""
    Write-Host ">>> 打开：$url" -ForegroundColor Green
    Start-Process $url
  }
}

Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action $handler | Out-Null
Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action {
  if ($EventArgs.Data) { Write-Host $EventArgs.Data -ForegroundColor DarkYellow }
} | Out-Null

[void]$proc.Start()
$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()

# 前台等待（Ctrl+C 可中断）
try {
  while (-not $proc.HasExited) { Start-Sleep -Milliseconds 400 }
} finally {
  if (-not $proc.HasExited) { $proc.Kill() }
  Get-EventSubscriber | Unregister-Event -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "服务已停止。" -ForegroundColor DarkGray
Write-Host "按回车关闭…" -ForegroundColor DarkGray
[void](Read-Host)
