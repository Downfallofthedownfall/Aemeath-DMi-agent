# ============================================================
# scripts/clean-sessions.ps1 — 清空项目内 dsh 会话/存储（开发用）
# 用途：强杀 web 实例后残留撕裂日志会导致 "id collision"，
#       清空后重启即可。数据均为开发冒烟数据。
# 用法：.\scripts\clean-sessions.ps1
# C25：文件带 UTF-8 BOM（PS 5.1 中文不乱码）；强杀 3081 监听进程前先确认。
# ============================================================
$root = Split-Path -Parent $PSScriptRoot
$home = Join-Path $root '.dsh-home'

# 找出占用 3081 的进程，强杀前先确认（C25：避免误杀其他程序占用的端口）
$pids = @()
$conns = Get-NetTCPConnection -LocalPort 3081 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) { $pids += $c.OwningProcess }
$pids = $pids | Select-Object -Unique
if ($pids.Count -gt 0) {
  Write-Host "将停止以下进程（占用 3081 端口）：$($pids -join ', ')"
  $ans = Read-Host "确认强杀这些进程并清空会话/存储？(y/N)"
  if ($ans -notmatch '^[yY]') {
    Write-Host "已取消。"
    exit 0
  }
  foreach ($p in $pids) {
    try { Stop-Process -Id $p -Force -ErrorAction Stop; Write-Host "stopped pid $p (port 3081)" } catch {}
  }
  Start-Sleep -Seconds 2
} else {
  Write-Host "3081 无监听进程，跳过强杀。"
}

foreach ($sub in 'sessions', 'storages') {
  $dir = Join-Path $home $sub
  if (Test-Path $dir) {
    Get-ChildItem $dir -Recurse -Force | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
    Write-Host "cleared .dsh-home/$sub"
  }
}
Write-Host "done. 重启: .\scripts\dsh.ps1 --profile aemeath --port 3081"
