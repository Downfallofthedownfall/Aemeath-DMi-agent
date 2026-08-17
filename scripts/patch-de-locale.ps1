# ============================================================
# patch-de-locale.ps1 - enable German (de) locale in dsh client-locale
# Background: @deepseek-ai/dsh-client-locale (rc.6) hardcodes
#   LOCALE_IDS=["zh","en"] and the LOCALES const only ships zh/en -
#   setLocale('de') throws and the language picker has no Deutsch.
#   This platform-level limitation lives in node_modules; this script
#   idempotently patches all three copies:
#     - <repo>/node_modules/@deepseek-ai/dsh-client-locale
#     - <repo>/profiles/aemeath/node_modules/@deepseek-ai/dsh-client-locale
#     - <repo>/app/node_modules/@deepseek-ai/dsh-client-locale
#   Re-run after every `npm install` (or add to setup.bat).
# Usage: powershell -ExecutionPolicy Bypass -File scripts\patch-de-locale.ps1
# NOTE: files are UTF-8 (no BOM) - always read/write with .NET UTF8
#       (PS 5.1 Get-Content defaults to ANSI and would corrupt CJK).
# ============================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-Utf8($path) {
  return [System.IO.File]::ReadAllText($path, $utf8NoBom)
}
function Write-Utf8($path, $content) {
  [System.IO.File]::WriteAllText($path, $content, $utf8NoBom)
}

$targets = @(
  (Join-Path $root 'node_modules\@deepseek-ai\dsh-client-locale'),
  (Join-Path $root 'profiles\aemeath\node_modules\@deepseek-ai\dsh-client-locale'),
  (Join-Path $root 'app\node_modules\@deepseek-ai\dsh-client-locale')
)

$patched = 0
foreach ($t in $targets) {
  $client = Join-Path $t 'lib\client.js'
  $hostIdx = Join-Path $t 'lib\index.js'
  if (-not (Test-Path $client)) { Write-Host "skip (missing): $client"; continue }

  # 1) client.js: LOCALE_IDS const add "de" (skip if already present)
  $c = Read-Utf8 $client
  $changed = $false
  if ($c -match 'const LOCALE_IDS = \["zh", "en"\]') {
    $c = $c -replace 'const LOCALE_IDS = \["zh", "en"\]', 'const LOCALE_IDS = ["zh", "en", "de"]'
    $changed = $true
  }
  # 2) client.js: LOCALES const - insert de entry after the en entry
  if ($c -match 'id: "en"' -and $c -notmatch 'id: "de"') {
    $c = $c -replace '(\s*\{\s*id: "en",\s*label: "English"\s*\})', '$1, { id: "de", label: "Deutsch" }'
    $changed = $true
  }
  if ($changed) {
    Write-Utf8 $client $c
    Write-Host "patched: $client"
    $patched++
  } else {
    Write-Host "already-patched or no-op: $client"
  }

  # 3) host index.js: LOCALE_IDS add "de" (settings schema validation)
  if (Test-Path $hostIdx) {
    $h = Read-Utf8 $hostIdx
    if ($h -match 'const LOCALE_IDS = \["zh", "en"\]' -and $h -notmatch '"de"') {
      $h = $h -replace 'const LOCALE_IDS = \["zh", "en"\]', 'const LOCALE_IDS = ["zh", "en", "de"]'
      Write-Utf8 $hostIdx $h
      Write-Host "patched: $hostIdx"
      $patched++
    } else {
      Write-Host "already-patched or no-op: $hostIdx"
    }
  }
}

Write-Host ''
Write-Host "patch-de-locale done: $patched file(s) patched (idempotent, re-runnable)."
if ($patched -eq 0) { Write-Host '(everything already up to date)' }
