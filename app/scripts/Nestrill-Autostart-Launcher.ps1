# Invoked at Windows sign-in; the browser intentionally remains closed.
# This script does not install a service or elevate privileges.
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$logs = Join-Path $root 'logs'
try {
  if (-not (Test-Path -LiteralPath $logs -PathType Container)) {
    New-Item -ItemType Directory -Path $logs -Force -ErrorAction Stop | Out-Null
  }
  $logPath = Join-Path $logs 'nestrill-autostart-last.log'
  $control = Join-Path $PSScriptRoot 'Nestrill-Control.ps1'
  & $control -Action Start -NoBrowser *>&1 | Out-String -Width 4096 | Set-Content -LiteralPath $logPath -Encoding UTF8
} catch {
  try {
    ('Autostart error: ' + $_.Exception.Message) | Add-Content -LiteralPath (Join-Path $logs 'nestrill-autostart-last.log') -Encoding UTF8
  } catch {}
}
