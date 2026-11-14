param([ValidateSet('Create','Remove')][string]$Action = 'Create')
$ErrorActionPreference = 'Stop'

# All-apps launcher is a normal Windows executable; it is always placed directly
# under the current user's Start Menu\Programs folder, not in a nested group.
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcher = Join-Path $root 'Nestrill.exe'
$iconPath = Join-Path $root 'assets\Nestrill.ico'
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$programs = [Environment]::GetFolderPath('Programs')
if (-not $desktop -or -not $programs) { throw 'Windows desktop or Start Menu folder could not be resolved.' }
$toolsMenu = Join-Path $programs 'Nestrill ツール'
$oldMenu = Join-Path $programs 'Nestrill'
$items = @(
  [PSCustomObject]@{Path=(Join-Path $programs 'Nestrill.lnk');Target=$launcher;Args='';Description='Nestrill を起動'},
  [PSCustomObject]@{Path=(Join-Path $desktop 'Nestrill.lnk');Target=$launcher;Args='';Description='Nestrill を起動'},
  [PSCustomObject]@{Path=(Join-Path $programs 'Nestrill を終了.lnk');Target=$launcher;Args='--stop';Description='Nestrill を終了'}
)
# Earlier portable releases used a nested Start Menu folder and .cmd target.
$legacy = @(
  [PSCustomObject]@{Path=(Join-Path $programs 'Nestrill の状態確認.lnk');Target=$launcher;Args='--status'},
  [PSCustomObject]@{Path=(Join-Path $toolsMenu 'Nestrill を終了.lnk');Target=$launcher;Args='--stop'},
  [PSCustomObject]@{Path=(Join-Path $toolsMenu 'Nestrill の状態確認.lnk');Target=$launcher;Args='--status'},
  [PSCustomObject]@{Path=(Join-Path $toolsMenu 'Nestrill 自動起動 ON.lnk');Target=(Join-Path $root 'Enable-Nestrill-Autostart.cmd');Args=''},
  [PSCustomObject]@{Path=(Join-Path $toolsMenu 'Nestrill 自動起動 OFF.lnk');Target=(Join-Path $root 'Disable-Nestrill-Autostart.cmd');Args=''},
  [PSCustomObject]@{Path=(Join-Path $toolsMenu 'Nestrill 自動起動の状態.lnk');Target=(Join-Path $root 'Show-Nestrill-Autostart-Status.cmd');Args=''},
  [PSCustomObject]@{Path=(Join-Path $desktop 'Nestrill.lnk');Target=(Join-Path $root 'Start-Nestrill.cmd');Args=''},
  [PSCustomObject]@{Path=(Join-Path $oldMenu 'Nestrill.lnk');Target=(Join-Path $root 'Start-Nestrill.cmd');Args=''},
  [PSCustomObject]@{Path=(Join-Path $oldMenu 'Nestrill を終了.lnk');Target=(Join-Path $root 'Stop-Nestrill.cmd');Args=''},
  [PSCustomObject]@{Path=(Join-Path $oldMenu 'Nestrill の状態確認.lnk');Target=(Join-Path $root 'Show-Nestrill-Status.cmd');Args=''},
  [PSCustomObject]@{Path=(Join-Path $oldMenu 'Nestrill 自動起動 ON.lnk');Target=(Join-Path $root 'Enable-Nestrill-Autostart.cmd');Args=''},
  [PSCustomObject]@{Path=(Join-Path $oldMenu 'Nestrill 自動起動 OFF.lnk');Target=(Join-Path $root 'Disable-Nestrill-Autostart.cmd');Args=''},
  [PSCustomObject]@{Path=(Join-Path $oldMenu 'Nestrill 自動起動の状態.lnk');Target=(Join-Path $root 'Show-Nestrill-Autostart-Status.cmd');Args=''}
)
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf) -or -not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
  throw 'Nestrill.exe or application icon not found.'
}
foreach ($target in @($items | ForEach-Object { $_.Target })) {
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Required target missing: $target" }
}
$shell = New-Object -ComObject WScript.Shell
function Owns($info) {
  if (-not (Test-Path -LiteralPath $info.Path -PathType Leaf)) { return $false }
  try {
    $link = $shell.CreateShortcut($info.Path)
    $same = [string]::Equals([IO.Path]::GetFullPath($link.TargetPath),[IO.Path]::GetFullPath($info.Target),[StringComparison]::OrdinalIgnoreCase)
    $sameArgs = [string]::Equals(([string]$link.Arguments).Trim(),([string]$info.Args).Trim(),[StringComparison]::OrdinalIgnoreCase)
    return ($same -and $sameArgs)
  } catch { return $false }
}
if ($Action -eq 'Create') {
  # Check for collisions before creating or changing any shortcut.
  foreach ($item in $items) {
    if (Test-Path -LiteralPath $item.Path) {
      if (Owns $item) { continue }
      $prev = @($legacy | Where-Object { $_.Path -eq $item.Path })
      if (@($prev | Where-Object { Owns $_ }).Count -eq 1) { continue }
      throw "Shortcut belongs to another installation; nothing was changed: $($item.Path)"
    }
  }
  foreach ($item in $items) {
    $dir = Split-Path -Parent $item.Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -ErrorAction Stop | Out-Null }
    $link = $shell.CreateShortcut($item.Path)
    $link.TargetPath = $item.Target
    $link.Arguments = $item.Args
    $link.WorkingDirectory = $root
    $link.IconLocation = $iconPath + ',0'
    $link.Description = $item.Description
    $link.Save()
  }
  if (-not (Owns $items[0])) { throw 'Could not create the Nestrill launcher in the Start Menu.' }
  foreach ($old in $legacy) { if (Owns $old) { Remove-Item -LiteralPath $old.Path -ErrorAction Stop } }
  if (Test-Path -LiteralPath $oldMenu -PathType Container) {
    if (@(Get-ChildItem -LiteralPath $oldMenu -Force).Count -eq 0) { Remove-Item -LiteralPath $oldMenu }
  }
  Write-Host 'Installed: Start > All apps > N > Nestrill'
  if (Test-Path -LiteralPath $toolsMenu -PathType Container) {
    if (@(Get-ChildItem -LiteralPath $toolsMenu -Force).Count -eq 0) { Remove-Item -LiteralPath $toolsMenu }
  }
  Write-Host 'You can remove the desktop shortcut without losing the Start Menu launcher.' 
  exit 0
}
# Remove only shortcuts belonging to this extracted folder, including legacy ones.
& (Join-Path $PSScriptRoot 'Nestrill-Autostart.ps1') -Action DisableIfOwned
foreach ($item in ($items + $legacy)) {
  if (Owns $item) { Remove-Item -LiteralPath $item.Path -ErrorAction Stop }
}
foreach ($dir in @($toolsMenu,$oldMenu)) {
  if (Test-Path -LiteralPath $dir -PathType Container) {
    if (@(Get-ChildItem -LiteralPath $dir -Force).Count -eq 0) { Remove-Item -LiteralPath $dir -ErrorAction Stop }
  }
}
Write-Host 'Only shortcuts of this exact Nestrill folder were removed; your user data is untouched.'
