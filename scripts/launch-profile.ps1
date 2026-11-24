# ============================================================
# scripts/launch-profile.ps1 — 课堂记录 / 习题模式的 Windows 启动器（两个模式共用一份）
#
# 双击仓库根的 lecture-launch.bat / exercise-launch.bat 会调到这里。
# 做四件事：装配检查 → 把 profile 接到 DSH_HOME → 启动 → 就绪后自动开浏览器。
# 与 mac 的 scripts/launch-mac.sh 对应，体验保持一致。
#
# 为什么两个模式共用一份：早先只有 lecture-launch.ps1，习题模式在 Windows 上没有
# 双击入口；再抄一份就是三处要同步的装配逻辑（这个仓库已经为"两份脚本漂移"
# 付过好几次代价）。差异只有 profile 名、默认端口和标题，收在下面的 $modes 表里。
#
# 用法（一般不直接调，走 .bat）：
#   .\scripts\launch-profile.ps1 -Mode lecture
#   .\scripts\launch-profile.ps1 -Mode exercise -Port 4000
#   .\scripts\launch-profile.ps1 -Mode lecture -SetupOnly     # 只装配，不启动
#   .\scripts\launch-profile.ps1 -Mode lecture -NoBrowser     # 启动但不开浏览器
# ============================================================
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('lecture', 'exercise')]
  [string]$Mode,

  # 0 = 取环境变量（AEMEATH_LECTURE_PORT / AEMEATH_EXERCISE_PORT，与 mac 同名），再取默认端口
  [int]$Port = 0,
  [switch]$SetupOnly,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$modes = @{
  lecture  = @{ Port = 3083; Title = 'Aemeath 课堂记录模式';       PortEnv = 'AEMEATH_LECTURE_PORT' }
  exercise = @{ Port = 3084; Title = 'Aemeath 习题模式（Übungen）'; PortEnv = 'AEMEATH_EXERCISE_PORT' }
}
$cfg = $modes[$Mode]
if ($Port -le 0) {
  $fromEnv = [Environment]::GetEnvironmentVariable($cfg.PortEnv)
  if ($fromEnv -match '^\d+$') { $Port = [int]$fromEnv } else { $Port = $cfg.Port }
}

# 装配锁（见下面「装配锁」一节）。放开它的函数要在 Die 之前就有：Die 会调它。
$script:setupLock = $null
$script:setupLockHeld = $false
function Exit-SetupLock {
  if ($script:setupLockHeld) {
    $script:setupLockHeld = $false
    # 放不掉时要说出来：否则另一个窗口会一直等，直到本窗口的服务退出，却看不出为什么。
    try { $script:setupLock.ReleaseMutex() } catch { Write-Warning "放开装配锁失败：$($_.Exception.Message)" }
  }
}

# 失败时只报错、退出码 1 —— "按任意键关闭"交给 .bat（它在非 0 退出时会停住窗口）。
# 这里再等一次回车的话，双击场景要按两次键才关得掉。
function Die($msg) {
  Exit-SetupLock
  Write-Host ""
  Write-Host "✗ $msg" -ForegroundColor Red
  Write-Host ""
  exit 1
}

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  $($cfg.Title)" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ---- Node 检查 ----
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Die "找不到 Node.js。请先安装 Node 24.9 或更新版本（https://nodejs.org），装完重开这个窗口。"
}
# ⚠️ 不要用 `node -p 'process.versions.node.split(".")[0]'`：
#    PowerShell 会把内层双引号吃掉，node 收到 split(.)[0] → SyntaxError。
#    直接解析 node -v 的输出，零引号嵌套。
$nodeVer = (& node -v) -replace '^v', ''
$verParts = $nodeVer -split '\.'
$major = [int]$verParts[0]
$minor = [int]$verParts[1]
# dsh 0.2.2 起要求 Node 24.9+，明确不再支持 Node 22（engines: >=24.9.0）—— 直接拦，
# 不再像 22.13 时代那样"放行但警告"：低版本上 dsh 本体就不保证能启动。
if ($major -lt 24 -or ($major -eq 24 -and $minor -lt 9)) {
  Die "Node 版本过低（当前 $nodeVer）。需要 24.9 或更新版本（dsh 0.2.2 起不再支持 Node 22）。"
}
Write-Host "Node: v$nodeVer" -ForegroundColor DarkGray
Write-Host ""

# ---- 装配锁：同一个仓库同一时间只让一个启动器装配 ----
#
# ⚠️ 真机踩过（mac，2026-11-23）：习题、课堂两个启动器前后一秒双击，两个 `npm install`
#    同时改仓库根的 node_modules —— 一个报 ENOTEMPTY 退出，另一个刷了几十条
#    TAR_ENTRY_ERROR 却返回 0，结果 node_modules 少了 308 个包（连 dsh 本身都没了），
#    两个窗口都报"npm install 失败"，看着像网络问题。Windows 上同样会撞（还多了
#    EPERM / EBUSY 文件占用）。mac 的修法在 scripts/profile-mac.sh 的「装配锁」。
#    依赖、构建产物、profile 链接都是两个模式共用的，所以下面"依赖 → 构建 → profile 链接"
#    整段串行：后到的那个等前一个装配完再走，装配完各自启动、互不影响。
#
# 用具名 Mutex，不用锁文件：持有者的窗口被强关、或脚本中途出错退出时，系统会把锁
# 收回（下一个等待者拿到的是 "abandoned"，照样算拿到），不会留下要手工删的旧锁。
# 名字里带仓库路径的哈希：两份不同的 clone 互不阻塞。Local\ = 只在当前登录会话内。
# 每秒醒一次再等，而不是无限期 WaitOne()：那样 Ctrl+C 中断不了。
$sha = [System.Security.Cryptography.SHA256]::Create()
try {
  $rootHash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant())) |
    Select-Object -First 8 | ForEach-Object { $_.ToString('x2') })
} finally {
  $sha.Dispose()
}
$script:setupLock = [System.Threading.Mutex]::new($false, "Local\aemeath-setup-$rootHash")

function Enter-SetupLock {
  $announced = $false
  $waitMs = 0
  while ($true) {
    try {
      if ($script:setupLock.WaitOne($waitMs)) { break }
    } catch [System.Threading.AbandonedMutexException] {
      # 上一个持有者没放锁就退出了：锁已归本进程。
      # 它的 npm install / 构建可能做了一半 —— 不要紧，下面的依赖比对和构建检查会照常补上。
      Write-Host "上一个启动器没放锁就退出了（窗口被关，或装配中途出错），锁已由系统收回。" -ForegroundColor DarkGray
      break
    }
    if (-not $announced) {
      Write-Host "另一个启动器正在装配（装依赖 / 构建），等它完成…" -ForegroundColor Yellow
      Write-Host "  两个模式共用仓库根的同一份依赖，不能同时装。" -ForegroundColor DarkGray
      $announced = $true
    }
    $waitMs = 1000
  }
  $script:setupLockHeld = $true
  if ($announced) { Write-Host "轮到本窗口装配。" -ForegroundColor Green }
}

Enter-SetupLock

# ---- 依赖（只在仓库根安装；绝不在 profiles\* 里跑 npm install，见 scripts\dsh.ps1）----
# 早先只在 dsh.cmd 不存在时才装：git pull 带来依赖升级（如 dsh 0.2.1 → 0.2.2）后
# node_modules 还是旧的，dsh.ps1 因版本不符拒绝启动（mac 上更糟：插件被 dsh 停用，
# 打开的是标准版 dsh）。现在每次都比对 package-lock.json，对不上就重装。
if (-not (Test-Path "$root\node_modules\.bin\dsh.cmd")) {
  Write-Host "首次运行：安装依赖…（需要几分钟）" -ForegroundColor Yellow
  $needInstall = $true
} else {
  & node "$root\scripts\check-deps.mjs"
  $needInstall = $LASTEXITCODE -ne 0
  if ($needInstall) {
    Write-Host "已装的依赖和 package-lock.json 对不上（多半是 git pull 带来了依赖升级），重新安装…" -ForegroundColor Yellow
  }
}
if ($needInstall) {
  & npm install
  if ($LASTEXITCODE -ne 0) { Die "npm install 失败。" }
  & node "$root\scripts\check-deps.mjs"
  if ($LASTEXITCODE -ne 0) { Die "npm install 之后依赖仍与 package-lock.json 不一致（差异见上）。可以试：删掉仓库根的 node_modules 后重新运行。" }
}

# ---- 构建（源码比产物新就重建）----
#
# ⚠️ 真机踩过两次，都是"改了没生效"：
#   第一次：条件是"产物 **不存在**才构建"——
#     packages\**\lib\ 被 gitignore → `git pull` 只更新源码，不更新产物；
#     产物已经存在（旧版）→ **永远跳过构建**。
#   第二次：改成比对时间戳后，**却只比 client**：
#     src\client → lib\client.js。而那次修的是 **host**（src\index.ts → lib\index.js），
#     client 没变 → 判断"不需要构建" → host 仍是旧的。
#
#   所以现在**遍历所有 workspace 包**，每个包同时比 host 与 client：
#     host:   src\**        vs  lib\index.js
#     client: src\client\** vs  lib\client.js
$needsBuild = $false
$commonDts = "$root\packages\shared\dsh-plugin-common\lib\index.d.ts"
if (-not (Test-Path $commonDts)) {
  $needsBuild = $true
} else {
  foreach ($pkg in (Get-ChildItem "$root\packages\*\*" -Directory -ErrorAction SilentlyContinue)) {
    $pkgJson = Join-Path $pkg.FullName 'package.json'
    $srcDir = Join-Path $pkg.FullName 'src'
    if (-not (Test-Path $pkgJson) -or -not (Test-Path $srcDir)) { continue }

    # host 产物
    $hostLib = Join-Path $pkg.FullName 'lib\index.js'
    if (-not (Test-Path $hostLib)) { $needsBuild = $true; break }
    $hostTime = (Get-Item $hostLib).LastWriteTimeUtc
    $newerHost = Get-ChildItem $srcDir -Recurse -File | Where-Object { $_.LastWriteTimeUtc -gt $hostTime } | Select-Object -First 1
    if ($newerHost) { $needsBuild = $true; break }

    # client 产物（只有带 src\client 的包才有）
    $clientSrcDir = Join-Path $srcDir 'client'
    if (Test-Path $clientSrcDir) {
      $clientLib = Join-Path $pkg.FullName 'lib\client.js'
      if (-not (Test-Path $clientLib)) { $needsBuild = $true; break }
      $clientTime = (Get-Item $clientLib).LastWriteTimeUtc
      $newerClient = Get-ChildItem $clientSrcDir -Recurse -File | Where-Object { $_.LastWriteTimeUtc -gt $clientTime } | Select-Object -First 1
      if ($newerClient) { $needsBuild = $true; break }
    }
  }
}

if ($needsBuild) {
  Write-Host "构建插件（有源码比产物新，或产物缺失）…" -ForegroundColor Yellow
  & npm run build
  if ($LASTEXITCODE -ne 0) { Die "构建失败。详见上方输出。" }
}

# ---- 把 profile 接到 DSH_HOME（幂等：已就绪就什么都不做）----
#
# ⚠️ 这一步早先**缺了**：dsh 只从 $DSH_HOME\profiles\<name> 找 profile，不读仓库里的
#    profiles\。没有这条链接，新克隆的机器上直接报
#        profile "lecture" does not exist
#    而在开发机上发现不了 —— 链接早就手工建好了。
#    同时把 profile 的 @deepseek-ai / @aemeath 依赖链到仓库根（两套模块实例会让
#    cordis 的私有 Symbol 对不上，见 scripts\link-profile.ps1 文件头）。
Write-Host "检查 profile 链接…" -ForegroundColor DarkGray
try {
  & (Join-Path $PSScriptRoot 'link-profile.ps1') -Profile $Mode -Quiet
} catch {
  Die "profile 链接失败：$($_.Exception.Message)"
}
if (-not (Test-Path "$root\.dsh-home\profiles\$Mode\package.json")) {
  Die "profile 没有接上：$root\.dsh-home\profiles\$Mode 里读不到 package.json。详见上方输出。"
}

# 共用的依赖 / 构建产物 / 链接都已就绪：放开装配锁，让另一个启动器接着装配。
Exit-SetupLock

# ---- 校验 profile 里声明了 preset 本体（这是 0.2.0 的真实机制）----
#
# ⚠️ 早先这里"同步 .agent-presets 目录"，那是 **DSH 0.1.1 的机制，0.2.0 无效**：
#   0.2.0 里 preset 是 profile patch 里的一个 `@deepseek-ai/dsh-agent-preset` 条目，
#   运行时里根本没有 ".agent-presets" 这个字符串。
#   照着过时注释做，结果是"同步成功了"但 preset 依然不存在 ——
#   创建会话报 agent-preset/not-found: Unknown agent preset: physicist。
#
#   所以现在只做**校验**：profile 必须声明 registry 默认的那个 preset。
$profilePatch = "$root\profiles\$Mode\cordis.patch.yml"
if (Test-Path $profilePatch) {
  $pp = Get-Content $profilePatch -Raw -Encoding UTF8
  if ($pp -notmatch '@deepseek-ai/dsh-agent-preset') {
    Write-Warning "profiles\$Mode\cordis.patch.yml 里没有 @deepseek-ai/dsh-agent-preset 声明。"
    Write-Warning "创建会话时会报 'Unknown agent preset: physicist'。"
  } else {
    Write-Host "profile preset 声明已校验。" -ForegroundColor DarkGray
  }
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
#
# ⚠️ 必须带 --no-open：dsh 默认会**自己**开一次浏览器，这里抓到地址后又开一次，
#    每次启动都是两个标签页。开浏览器这件事统一由本脚本做（抓到的地址带 token，
#    而且能顺手打印出来，浏览器没弹出时用户还能手动复制）。
$env:DSH_HOME = "$root\.dsh-home"
$dsh = "$root\node_modules\.bin\dsh.cmd"

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $dsh
$psi.Arguments = "--profile $Mode --port $Port --no-open"
$psi.WorkingDirectory = $root
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.StandardOutputEncoding = [Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [Text.Encoding]::UTF8
$psi.EnvironmentVariables['DSH_HOME'] = $env:DSH_HOME

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi

# 事件回调跑在它自己的作用域里，看不到本脚本的变量：
#   · 要用的开关经 -MessageData 传进去；
#   · "只开一次"的标记放在回调自己的 $script: 作用域（同一个回调多次触发时共享）。
$handler = {
  if (-not $EventArgs.Data) { return }
  $line = $EventArgs.Data
  Write-Host $line
  if (-not $script:opened -and $line -match 'dsh web:\s+(http\S+)') {
    $script:opened = $true
    $url = $Matches[1]
    Write-Host ""
    if ($Event.MessageData.NoBrowser) {
      Write-Host ">>> 就绪：$url" -ForegroundColor Green
    } else {
      Write-Host ">>> 打开：$url" -ForegroundColor Green
      Start-Process $url
    }
  }
}

Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action $handler -MessageData @{ NoBrowser = [bool]$NoBrowser } | Out-Null
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

$code = $proc.ExitCode
Write-Host ""
Write-Host "服务已停止（退出码 $code）。" -ForegroundColor DarkGray
if ($code -ne 0) {
  # 非 0 = 服务自己挂了（端口被占、配置坏了…）。把退出码交给 .bat，由它停住窗口让人看报错。
  exit $code
}
Write-Host "按回车关闭…" -ForegroundColor DarkGray
[void](Read-Host)
