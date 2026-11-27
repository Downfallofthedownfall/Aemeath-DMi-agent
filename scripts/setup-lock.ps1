# ============================================================
# scripts/setup-lock.ps1 — 仓库级装配锁（Windows）：同一时间只让一个脚本改仓库根的
#                          node_modules / 构建产物 / profile 链接
#
# 用法（dot-source：函数和锁对象落在调用方的作用域里）：
#   . (Join-Path $PSScriptRoot 'setup-lock.ps1')
#   Enter-SetupLock     # 等到轮到自己
#   …npm install / npm run build / 建链接…
#   Exit-SetupLock      # 幂等；调用方中途退出时系统也会收回锁
#
# 谁在用：scripts\launch-profile.ps1（课堂 / 习题启动器）、scripts\setup-root.ps1（setup.bat）。
# mac 的对应物在 scripts/profile-mac.sh 的「装配锁」。
#
# ⚠️ 真机踩过（mac，2026-11-23）：习题、课堂两个启动器前后一秒双击，两个 `npm install`
#    同时改仓库根的 node_modules —— 一个报 ENOTEMPTY 退出，另一个刷了几十条
#    TAR_ENTRY_ERROR 却返回 0，结果 node_modules 少了 308 个包（连 dsh 本身都没了），
#    两个窗口都报"npm install 失败"，看着像网络问题。Windows 上同样会撞（还多了
#    EPERM / EBUSY 文件占用）。setup.bat 和启动器同时跑也一样，所以它们共用这一把锁。
#
# 用具名 Mutex，不用锁文件：持有者的窗口被强关、或脚本中途出错退出时，系统会把锁
# 收回（下一个等待者拿到的是 "abandoned"，照样算拿到），不会留下要手工删的旧锁。
# 名字里带仓库路径的哈希：两份不同的 clone 互不阻塞。Local\ = 只在当前登录会话内。
# 路径取本文件所在目录的上一级：所有调用方 dot-source 的是同一个文件，哈希输入一致。
# 每秒醒一次再等，而不是无限期 WaitOne()：那样 Ctrl+C 中断不了。
# ============================================================

$script:setupLockHeld = $false
$setupLockSha = [System.Security.Cryptography.SHA256]::Create()
try {
  $setupLockRoot = (Split-Path -Parent $PSScriptRoot).ToLowerInvariant()
  $setupLockHash = -join ($setupLockSha.ComputeHash([Text.Encoding]::UTF8.GetBytes($setupLockRoot)) |
    Select-Object -First 8 | ForEach-Object { $_.ToString('x2') })
} finally {
  $setupLockSha.Dispose()
}
$script:setupLock = [System.Threading.Mutex]::new($false, "Local\aemeath-setup-$setupLockHash")

function Enter-SetupLock {
  $announced = $false
  $waitMs = 0
  while ($true) {
    try {
      if ($script:setupLock.WaitOne($waitMs)) { break }
    } catch [System.Threading.AbandonedMutexException] {
      # 上一个持有者没放锁就退出了：锁已归本进程。
      # 它的 npm install / 构建可能做了一半 —— 不要紧，后面的依赖比对和构建检查会照常补上。
      Write-Host "上一个装配脚本没放锁就退出了（窗口被关，或装配中途出错），锁已由系统收回。" -ForegroundColor DarkGray
      break
    }
    if (-not $announced) {
      Write-Host "另一个启动器 / setup.bat 正在装配（装依赖 / 构建），等它完成…" -ForegroundColor Yellow
      Write-Host "  课堂、习题和 setup.bat 共用仓库根的同一份依赖，不能同时装。" -ForegroundColor DarkGray
      $announced = $true
    }
    $waitMs = 1000
  }
  $script:setupLockHeld = $true
  if ($announced) { Write-Host "轮到本窗口装配。" -ForegroundColor Green }
}

function Exit-SetupLock {
  if ($script:setupLockHeld) {
    $script:setupLockHeld = $false
    # 放不掉时要说出来：否则另一个窗口会一直等，直到本窗口退出，却看不出为什么。
    try { $script:setupLock.ReleaseMutex() } catch { Write-Warning "放开装配锁失败：$($_.Exception.Message)" }
  }
}
