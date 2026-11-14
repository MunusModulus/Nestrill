param(
  [ValidateSet('Enable','Disable','Status','DisableIfOwned')][string]$Action = 'Status',
  [switch]$OutputJson
)
$ErrorActionPreference = 'Stop'

# Per-user Windows Startup folder; no admin rights, registry, service or task scheduler.
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcher = Join-Path $PSScriptRoot 'Nestrill-Autostart-Launcher.ps1'
$startup = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
if ([string]::IsNullOrWhiteSpace($startup) -or -not (Test-Path -LiteralPath $startup -PathType Container)) {
  throw 'Windows Startup folder could not be resolved.'
}
$linkPath = Join-Path $startup 'Nestrill.lnk'
$psExe = Join-Path $PSHOME 'powershell.exe'
$icon = Join-Path $root 'assets\Nestrill.ico'
$arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '"'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw ('Autostart launcher missing: ' + $launcher) }
if (-not (Test-Path -LiteralPath $psExe -PathType Leaf)) { throw ('PowerShell missing: ' + $psExe) }
$shell = New-Object -ComObject WScript.Shell

function Check-Existing {
  if (-not (Test-Path -LiteralPath $linkPath)) { return 'Absent' }
  if (-not (Test-Path -LiteralPath $linkPath -PathType Leaf)) { return 'Other' }
  try {
    $lnk = $shell.CreateShortcut($linkPath)
    $actualExe = [System.IO.Path]::GetFullPath([string]$lnk.TargetPath)
    $expectedExe = [System.IO.Path]::GetFullPath($psExe)
    if ([string]::Equals($actualExe, $expectedExe, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals(([string]$lnk.Arguments).Trim(), $arguments, [System.StringComparison]::OrdinalIgnoreCase)) {
      return 'Owned'
    }
  } catch {}
  return 'Other'
}

$current = Check-Existing
function Write-State([bool]$enabled, [bool]$conflict) {
  [PSCustomObject]@{ supported = $true; enabled = $enabled; conflict = $conflict } |
    ConvertTo-Json -Compress | Write-Output
}
if ($Action -eq 'Status') {
  if ($OutputJson) {
    Write-State ($current -eq 'Owned') ($current -eq 'Other')
    exit 0
  }
  if ($current -eq 'Owned') { Write-Host 'Nestrill autostart: ON (this folder)' }
  elseif ($current -eq 'Absent') { Write-Host 'Nestrill autostart: OFF' }
  else { Write-Host 'Nestrill autostart: a different shortcut exists; it was not changed.' }
  exit 0
}
if ($Action -eq 'Enable') {
  if ($current -eq 'Other') { throw ('Another autostart shortcut exists. No changes made: ' + $linkPath) }
  if ($current -eq 'Owned') {
    if ($OutputJson) { Write-State $true $false }
    else { Write-Host 'Nestrill autostart is already ON.' }
    exit 0
  }
  if (-not (Test-Path -LiteralPath $icon -PathType Leaf)) { throw ('Icon missing: ' + $icon) }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'server.js') -PathType Leaf)) { throw 'server.js missing.' }
  $lnk = $shell.CreateShortcut($linkPath)
  $lnk.TargetPath = $psExe
  $lnk.Arguments = $arguments
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = ($icon + ',0')
  $lnk.Description = 'Nestrill starts at Windows sign-in, without opening the browser.'
  $lnk.Save()
  if ($OutputJson) { Write-State $true $false }
  else { Write-Host 'Nestrill autostart: ON. Server starts on next Windows sign-in; browser stays closed.' }
  exit 0
}
if ($current -eq 'Owned') {
  Remove-Item -LiteralPath $linkPath -ErrorAction Stop
  if ($OutputJson) { Write-State $false $false }
  else { Write-Host 'Nestrill autostart: OFF. No running server or user data was changed.' }
} elseif ($Action -eq 'DisableIfOwned') {
  if ($OutputJson) { Write-State $false ($current -eq 'Other') }
  else { Write-Host 'No autostart shortcut owned by this folder; nothing was removed.' }
} elseif ($current -eq 'Absent') {
  if ($OutputJson) { Write-State $false $false }
  else { Write-Host 'Nestrill autostart is already OFF.' }
} else {
  throw ('A different autostart shortcut exists. Nothing was removed: ' + $linkPath)
}
exit 0
