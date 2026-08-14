# ============================================================
# scripts/clean-sessions.ps1 — 清空项目内 dsh 会话/存储（开发用）
# 用途：强杀 web 实例后残留撕裂日志会导致 "id collision"，
#       清空后重启即可。数据均为开发冒烟数据。
# 用法：.\scripts\clean-sessions.ps1
# ============================================================
$root = Split-Path -Parent $PSScriptRoot
$home = Join-Path $root '.dsh-home'

# 先尝试优雅停掉占用端口的实例
foreach ($port in 3081) {
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop; Write-Host "stopped pid $($c.OwningProcess) (port $port)" } catch {}
  }
}
Start-Sleep -Seconds 2

foreach ($sub in 'sessions', 'storages') {
  $dir = Join-Path $home $sub
  if (Test-Path $dir) {
    Get-ChildItem $dir -Recurse -Force | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
    Write-Host "cleared .dsh-home/$sub"
  }
}
Write-Host "done. 重启: .\scripts\dsh.ps1 --profile aemeath --port 3081"
