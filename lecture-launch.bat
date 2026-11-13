@echo off
REM ============================================================
REM Lecture Mode launcher (Windows) - double-click this file.
REM
REM Why a .bat: double-clicking a .ps1 opens it in Notepad instead
REM of running it. This wrapper calls PowerShell with the right
REM execution policy, and keeps the window open on failure so the
REM error is actually readable.
REM
REM The real work lives in scripts\launch-profile.ps1, shared with
REM exercise-launch.bat (only the -Mode argument differs).
REM
REM NOTE: keep this file ASCII-only. cmd.exe reads .bat according to
REM the console code page, not UTF-8, so non-ASCII comments here turn
REM into garbage that gets executed as commands.
REM All user-facing Chinese text lives in the .ps1 (which has a BOM).
REM ============================================================
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-profile.ps1" -Mode lecture %*

if errorlevel 1 (
  echo.
  echo Exited with an error. Press any key to close...
  pause >nul
)
endlocal
