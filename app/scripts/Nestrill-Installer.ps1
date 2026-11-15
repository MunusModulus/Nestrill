# Nestrill per-user installer and complete per-installation data-removing uninstaller.
# Copyright (c) 2026 Munus Modulus — MIT License.
param(
  [ValidateSet('Install','Uninstall')][string]$Mode = 'Install',
  [string]$PayloadPath = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$script:AppId = 'MunusModulus.Nestrill.Setup.v1'
$script:Release = '0.2.0'
$script:ManifestName = '.nestrill-install-manifest.json'
$script:RegPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\MunusModulus.Nestrill'
$script:PsExe = Join-Path $PSHOME 'powershell.exe'

function Notice([string]$message, [string]$title='Nestrill', [string]$kind='Information') {
  [System.Windows.Forms.MessageBox]::Show($message,$title,[System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Enum]::Parse([System.Windows.Forms.MessageBoxIcon],$kind)) | Out-Null
}
function Confirm([string]$message, [string]$title='Nestrill') {
  $answer = [System.Windows.Forms.MessageBox]::Show($message,$title,
    [System.Windows.Forms.MessageBoxButtons]::YesNo,[System.Windows.Forms.MessageBoxIcon]::Question)
  return ($answer -eq [System.Windows.Forms.DialogResult]::Yes)
}
function ShowInstallComplete([string]$root) {
  $done = New-Object System.Windows.Forms.Form
  $done.Text = 'Nestrill セットアップ完了'
  $done.Size = New-Object System.Drawing.Size(640,376)
  $done.StartPosition = 'CenterScreen'
  $done.FormBorderStyle = 'FixedDialog'
  $done.MaximizeBox = $false
  $done.MinimizeBox = $false
  $done.Font = New-Object System.Drawing.Font('Yu Gothic UI',10)
  $title = New-Object System.Windows.Forms.Label
  $title.Text = 'Nestrillのインストールが完了しました'
  $title.AutoSize = $true
  $title.Font = New-Object System.Drawing.Font('Yu Gothic UI',13,[System.Drawing.FontStyle]::Bold)
  $title.Location = New-Object System.Drawing.Point(24,18)
  $done.Controls.Add($title)
  $startHint = New-Object System.Windows.Forms.Label
  $startHint.Text = 'スタートメニューのN欄から「Nestrill」を起動できます。'
  $startHint.AutoSize = $true
  $startHint.Location = New-Object System.Drawing.Point(24,57)
  $done.Controls.Add($startHint)
  $bookmark = New-Object System.Windows.Forms.Label
  $bookmark.Text = 'PCのブラウザのお気に入りに登録すると便利です。'
  $bookmark.AutoSize = $true
  $bookmark.Location = New-Object System.Drawing.Point(24,95)
  $done.Controls.Add($bookmark)
  $url = New-Object System.Windows.Forms.TextBox
  $url.Location = New-Object System.Drawing.Point(24,122)
  $url.Size = New-Object System.Drawing.Size(467,29)
  $url.ReadOnly = $true
  $url.Text = 'http://127.0.0.1:8767/'
  $done.Controls.Add($url)
  $copy = New-Object System.Windows.Forms.Button
  $copy.Text = 'コピー'
  $copy.Location = New-Object System.Drawing.Point(504,120)
  $copy.Size = New-Object System.Drawing.Size(100,30)
  $copy.Add_Click({
    try { [System.Windows.Forms.Clipboard]::SetText($url.Text) }
    catch { Notice 'URLをコピーできませんでした。URL欄を選択してコピーしてください。' 'Nestrill' 'Warning' }
  })
  $done.Controls.Add($copy)
  $hint = New-Object System.Windows.Forms.Label
  $hint.Text = 'Nestrillが起動している間だけ開けます（このPC専用のURL）。'
  $hint.AutoSize = $true
  $hint.Location = New-Object System.Drawing.Point(24,161)
  $done.Controls.Add($hint)
  $aiHint = New-Object System.Windows.Forms.Label
  $aiHint.Text = 'AIセレクトを使う方は「設定 → AIセレクト」でモデルを確認してください。'
  $aiHint.AutoSize = $true
  $aiHint.Location = New-Object System.Drawing.Point(24,190)
  $done.Controls.Add($aiHint)
  $mobile = New-Object System.Windows.Forms.Label
  $mobile.Text = 'スマホ閲覧は任意です。外出先接続には第三者サービスの設定が必要です。'
  $mobile.AutoSize = $true
  $mobile.Location = New-Object System.Drawing.Point(24,222)
  $done.Controls.Add($mobile)
  $openGuide = New-Object System.Windows.Forms.Button
  $openGuide.Text = 'スマホ接続ガイドを開く'
  $openGuide.Location = New-Object System.Drawing.Point(24,272)
  $openGuide.Size = New-Object System.Drawing.Size(226,35)
  $guidePath = Join-Path $root 'MOBILE_SETUP.md'
  $openGuide.Add_Click({
    try {
      if (-not (Test-Path -LiteralPath $guidePath -PathType Leaf)) { throw 'スマホ接続ガイドが見つかりません。' }
      Start-Process -FilePath 'notepad.exe' -ArgumentList ('"' + $guidePath + '"') -ErrorAction Stop | Out-Null
    } catch { Notice $_.Exception.Message 'スマホ接続ガイドを開けませんでした' 'Warning' }
  })
  $done.Controls.Add($openGuide)
  $closeButton = New-Object System.Windows.Forms.Button
  $closeButton.Text = '閉じる'
  $closeButton.Location = New-Object System.Drawing.Point(509,272)
  $closeButton.Size = New-Object System.Drawing.Size(95,35)
  $closeButton.Add_Click({ $done.Close() })
  $done.Controls.Add($closeButton)
  $done.AcceptButton = $closeButton
  [void]$done.ShowDialog()
}

function SamePath([string]$a,[string]$b) {
  try { return [string]::Equals([IO.Path]::GetFullPath($a).TrimEnd('\'),[IO.Path]::GetFullPath($b).TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase) }
  catch { return $false }
}
function CheckedRelative([string]$relative, [string]$root) {
  if ([string]::IsNullOrWhiteSpace($relative) -or [IO.Path]::IsPathRooted($relative) -or $relative.Contains(':')) { throw "Unsafe package path: $relative" }
  $parts = $relative.Replace('\','/').Split('/')
  if (@($parts | Where-Object { $_ -eq '.' -or $_ -eq '..' -or $_ -eq '' }).Count -gt 0) { throw "Unsafe package path: $relative" }
  if ($parts[0] -in @('data','run','logs')) { throw "Runtime-data path in release package: $relative" }
  $base = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
  $result = [IO.Path]::GetFullPath((Join-Path $root ($relative.Replace('/','\'))))
  if (-not $result.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe path outside install directory: $relative" }
  return $result
}
function PortIsBusy {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $client.BeginConnect('127.0.0.1',8767,$null,$null)
    if (-not $ar.AsyncWaitHandle.WaitOne(400)) { return $false }
    $client.EndConnect($ar)
    return $true
  } catch { return $false }
  finally { $client.Close() }
}
function TestNodeVersion {
  try {
    $node = Get-Command node.exe -ErrorAction Stop
    $ver = [version]((& $node.Source --version).Trim().TrimStart('v'))
    if ($ver.Major -gt 22 -or ($ver.Major -eq 22 -and $ver.Minor -ge 16)) { return "Node.js $ver：利用可能" }
    return "Node.js $ver：22.16以上が必要です"
  } catch { return 'Node.jsが見つかりません。22.16以上を別途導入してください。' }
}
function LoadManifest([string]$root) {
  $file = Join-Path $root $script:ManifestName
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
  $obj = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($obj.appId -ne $script:AppId) { throw 'このフォルダは別のアプリのインストール記録を持っています。変更しません。' }
  return $obj
}
function GetLinks([string]$root, [bool]$desktopEnabled) {
  $desktop = [Environment]::GetFolderPath('DesktopDirectory')
  $programs = [Environment]::GetFolderPath('Programs')
  if (-not $desktop -or -not $programs) { throw 'Windowsのデスクトップ／スタートメニューが見つかりません。' }
  $launcher = Join-Path $root 'Nestrill.exe'
  # ALWAYS register both start and stop at the top level of All apps -> N.
  # The Windows 11 Recommended/Recently added area is temporary and not a navigation path.
  $result = @(
    [PSCustomObject]@{ File=(Join-Path $programs 'Nestrill.lnk'); Target=$launcher; Args='' },
    [PSCustomObject]@{ File=(Join-Path $programs 'Nestrill を終了.lnk'); Target=$launcher; Args='--stop' }
  )
  if ($desktopEnabled) { $result += [PSCustomObject]@{ File=(Join-Path $desktop 'Nestrill.lnk'); Target=$launcher; Args='' } }
  # Uninstall lives in Windows Settings > Apps > Installed apps, not Recommended.
  return @($result)
}
function GetR12Links([string]$root) {
  # The old auxiliary entries were in a folder. Remove only links targeting THIS installation.
  $programs = [Environment]::GetFolderPath('Programs')
  $toolsMenu = Join-Path $programs 'Nestrill ツール'
  $launcher = Join-Path $root 'Nestrill.exe'
  $scriptPath = Join-Path $root 'scripts\Nestrill-Installer.ps1'
  $args = '-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $scriptPath + '" -Mode Uninstall'
  return @(
    [PSCustomObject]@{ File=(Join-Path $toolsMenu 'Nestrill を終了.lnk'); Target=$launcher; Args='--stop' },
    [PSCustomObject]@{ File=(Join-Path $toolsMenu 'Nestrill の状態確認.lnk'); Target=$launcher; Args='--status' },
    [PSCustomObject]@{ File=(Join-Path $toolsMenu 'Nestrill をアンインストール.lnk'); Target=$script:PsExe; Args=$args }
  )
}
function GetLegacyLinks([string]$root) {
  # R11 stored all shortcuts in a folder named Nestrill and targeted .cmd files.
  $desktop = [Environment]::GetFolderPath('DesktopDirectory')
  $programs = [Environment]::GetFolderPath('Programs')
  $oldMenu = Join-Path $programs 'Nestrill'
  $uninstallScript = Join-Path $root 'scripts\Nestrill-Installer.ps1'
  $args = '-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $uninstallScript + '" -Mode Uninstall'
  return @(
    [PSCustomObject]@{ File=(Join-Path $desktop 'Nestrill.lnk'); Target=(Join-Path $root 'Start-Nestrill.cmd'); Args='' },
    [PSCustomObject]@{ File=(Join-Path $oldMenu 'Nestrill.lnk'); Target=(Join-Path $root 'Start-Nestrill.cmd'); Args='' },
    [PSCustomObject]@{ File=(Join-Path $oldMenu 'Nestrill を終了.lnk'); Target=(Join-Path $root 'Stop-Nestrill.cmd'); Args='' },
    [PSCustomObject]@{ File=(Join-Path $oldMenu 'Nestrill の状態確認.lnk'); Target=(Join-Path $root 'Show-Nestrill-Status.cmd'); Args='' },
    [PSCustomObject]@{ File=(Join-Path $oldMenu 'Nestrill をアンインストール.lnk'); Target=$script:PsExe; Args=$args }
  )
}
function LinkOwned($linkInfo,$shell) {
  if (-not (Test-Path -LiteralPath $linkInfo.File -PathType Leaf)) { return $false }
  try {
    $lnk = $shell.CreateShortcut($linkInfo.File)
    return (SamePath ([string]$lnk.TargetPath) $linkInfo.Target) -and
      ([string]::Equals(([string]$lnk.Arguments).Trim(),([string]$linkInfo.Args).Trim(),[StringComparison]::OrdinalIgnoreCase))
  } catch { return $false }
}
function PreflightShortcuts([object[]]$links,$shell,[string]$root) {
  $legacy = @(GetLegacyLinks $root)
  foreach ($link in $links) {
    if (Test-Path -LiteralPath $link.File) {
      if (LinkOwned $link $shell) { continue }
      # Upgrade of the SAME R11 install: allow updating only its old desktop launcher.
      $oldSamePath = @($legacy | Where-Object { $_.File -eq $link.File })
      if (@($oldSamePath | Where-Object { LinkOwned $_ $shell }).Count -eq 1) { continue }
      throw "別のNestrill環境のショートカットが存在します。先に旧環境で解除してください。`n$($link.File)"
    }
  }
}
function WriteShortcuts([object[]]$links, [string]$root, $shell) {
  $ico = Join-Path $root 'assets\Nestrill.ico'
  foreach ($entry in $links) {
    $parent = Split-Path -Parent $entry.File
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $lnk = $shell.CreateShortcut($entry.File)
    $lnk.TargetPath = $entry.Target
    $lnk.Arguments = $entry.Args
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation = "$ico,0"
    $lnk.Description = 'Nestrill'
    $lnk.Save()
  }
}
function CleanupLegacyLinks([string]$root,$shell) {
  # Only remove links whose target/args prove they belong to this exact install.
  foreach ($old in @((GetLegacyLinks $root) + (GetR12Links $root))) {
    if (LinkOwned $old $shell) { Remove-Item -LiteralPath $old.File -ErrorAction Stop }
  }
  # Remove the former R14 optional Status link only when owned by THIS installation.
  $status = [PSCustomObject]@{
    File=(Join-Path ([Environment]::GetFolderPath('Programs')) 'Nestrill の状態確認.lnk')
    Target=(Join-Path $root 'Nestrill.exe'); Args='--status'
  }
  if (LinkOwned $status $shell) { Remove-Item -LiteralPath $status.File -ErrorAction Stop }
  $programs = [Environment]::GetFolderPath('Programs')
  foreach ($menuName in @('Nestrill','Nestrill ツール')) {
    $oldMenu = Join-Path $programs $menuName
    if ((Test-Path -LiteralPath $oldMenu -PathType Container) -and
        @(Get-ChildItem -LiteralPath $oldMenu -Force).Count -eq 0) {
      Remove-Item -LiteralPath $oldMenu -ErrorAction Stop
    }
  }
}
function RemoveOwnedLinks([string]$root,$shell) {
  # Never delete a shortcut unless its target AND arguments match this installation.
  $items = @(GetLinks $root $true)
  foreach ($item in $items) {
    if (LinkOwned $item $shell) { Remove-Item -LiteralPath $item.File -ErrorAction Stop }
  }
  CleanupLegacyLinks $root $shell
}
function SetUninstallRegistration([string]$root) {
  $reg = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($script:RegPath)
  try {
    $cmd = '"' + $script:PsExe + '" -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $root 'scripts\Nestrill-Installer.ps1') + '" -Mode Uninstall'
    $reg.SetValue('DisplayName','Nestrill')
    $reg.SetValue('DisplayVersion',$script:Release)
    $reg.SetValue('Publisher','Munus Modulus')
    $reg.SetValue('InstallLocation',$root)
    $reg.SetValue('UninstallString',$cmd)
    $reg.SetValue('DisplayIcon',(Join-Path $root 'assets\Nestrill.ico'))
    $reg.SetValue('NoModify',1,[Microsoft.Win32.RegistryValueKind]::DWord)
    $reg.SetValue('NoRepair',1,[Microsoft.Win32.RegistryValueKind]::DWord)
  } finally { $reg.Close() }
}
function RemoveUninstallRegistration([string]$root) {
  $reg = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($script:RegPath)
  if ($reg) {
    try { $target = [string]$reg.GetValue('InstallLocation') }
    finally { $reg.Close() }
    if (SamePath $root $target) {
      [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($script:RegPath,$false)
    }
  }
}
function DoInstall([string]$root, [bool]$desktopEnabled) {
  if (-not (Test-Path -LiteralPath $PayloadPath -PathType Leaf)) { throw '組み込みの配布ファイルがありません。' }
  $root = [IO.Path]::GetFullPath($root).TrimEnd('\')
  $base = [IO.Path]::GetPathRoot($root).TrimEnd('\')
  if (-not $root -or (SamePath $root $base) -or (SamePath $root $env:USERPROFILE) -or
      $root.StartsWith($env:SystemRoot.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or
      $root.StartsWith($env:TEMP.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) {
    throw 'このフォルダにはインストールできません。専用の空フォルダを選んでください。'
  }
  $existing = $null
  if (Test-Path -LiteralPath $root) {
    $existing = LoadManifest $root
    if (-not $existing -and @(Get-ChildItem -LiteralPath $root -Force).Count -gt 0) {
      throw '導入先が空ではなく、Nestrillインストーラーによる管理対象でもありません。別の空フォルダを指定してください。'
    }
  }
  $shell = New-Object -ComObject WScript.Shell
  $links = GetLinks $root $desktopEnabled
  PreflightShortcuts $links $shell $root
  if (PortIsBusy) {
    if ($existing -and $existing.state -eq 'installed') {
      # Upgrading this exact installation: stop only its verified server.
      StopOwnedServer $root
    } else {
      throw 'ポート8767が使用中です。別のNestrill／アプリは停止しません。起動している環境を終了してから導入してください。'
    }
  }
  $stage = Join-Path $env:TEMP ('Nestrill-stage-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($PayloadPath)
    try {
      $entries = @($archive.Entries | Where-Object { $_.Name -ne '' })
      foreach ($entry in $entries) { $null = CheckedRelative $entry.FullName $root }
    } finally { $archive.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($PayloadPath,$stage)
    $files = @()
    foreach ($entry in $entries) {
      $rel = $entry.FullName.Replace('\','/')
      $src = CheckedRelative $rel $stage
      $dst = CheckedRelative $rel $root
      if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { throw "配布ファイルの欠落: $rel" }
      $hash = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash.ToLowerInvariant()
      # Existing code is only overwritten when it still matches the previous install manifest.
      if (Test-Path -LiteralPath $dst) {
        $previous = @($existing.files | Where-Object { $_.path -eq $rel } | Select-Object -First 1)
        if ($previous.Count -ne 1 -or -not (Test-Path -LiteralPath $dst -PathType Leaf) -or
            ((Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$previous[0].sha256)) {
          throw "変更済みまたは管理外のファイルを保護するため中止しました: $rel"
        }
      }
      $files += [PSCustomObject]@{path=$rel;sha256=$hash}
    }
    if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root -Force | Out-Null }
    foreach ($entry in $files) {
      $src = CheckedRelative $entry.path $stage
      $dst = CheckedRelative $entry.path $root
      $parent = Split-Path -Parent $dst
      if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
      Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop
    }
    # The earlier Release Candidate bundled a temporary first-read notice.
    # If upgrading, remove only the unchanged, manifest-owned obsolete file.
    # Modified / unrecognized files always remain untouched.
    if ($existing) {
      $obsoleteRel = 'README_RC01_FIRST.txt'
      $previousNotice = @($existing.files | Where-Object { $_.path -eq $obsoleteRel })
      if ($previousNotice.Count -eq 1) {
        $obsoleteFile = CheckedRelative $obsoleteRel $root
        if (Test-Path -LiteralPath $obsoleteFile -PathType Leaf) {
          $noticeInfo = Get-Item -LiteralPath $obsoleteFile -Force -ErrorAction Stop
          if (($noticeInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and
              (Get-FileHash -LiteralPath $obsoleteFile -Algorithm SHA256).Hash.ToLowerInvariant() -eq
              [string]$previousNotice[0].sha256) {
            Remove-Item -LiteralPath $obsoleteFile -Force -ErrorAction Stop
          }
        }
      }
    }
    $manifest = [ordered]@{appId=$script:AppId;version=$script:Release;state='installed'; files=@($files)}
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $root $script:ManifestName) -Encoding UTF8
    WriteShortcuts $links $root $shell
    # Verify the critical launcher link was actually created; Start Menu indexing
    # itself is Windows-controlled and needs to be confirmed on a real PC.
    $primary = (GetLinks $root $false)[0]
    if (-not (LinkOwned $primary $shell)) { throw 'スタートメニューのNestrill起動リンクを作成できませんでした。' }
    CleanupLegacyLinks $root $shell
    if (-not $desktopEnabled) {
      $oldDesktop = [PSCustomObject]@{
        File=(Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Nestrill.lnk')
        Target=(Join-Path $root 'Nestrill.exe'); Args=''
      }
      if (LinkOwned $oldDesktop $shell) { Remove-Item -LiteralPath $oldDesktop.File -ErrorAction Stop }
    }
    SetUninstallRegistration $root
    return $root
  } finally {
    # Only a unique, installer-created staging folder is removed.
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
# Removing the application's own data is intentional on uninstall.  Never follow
# junctions/symlinks (reparse points), or delete unrecognized adjacent content.
function Assert-NoReparseTree([string]$top) {
  if (-not (Test-Path -LiteralPath $top)) { return }
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($top)
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    $info = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "リンク／ジャンクションを検出しました。安全のため削除しません: $current"
    }
    if ($info.PSIsContainer) {
      foreach ($child in @(Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop)) {
        $pending.Push($child.FullName)
      }
    }
  }
}
function Assert-OwnedPackagePaths([string]$root, $manifest) {
  # The install root and all managed subfolders must be ordinary directories.
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'インストール先がありません。' }
  if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'インストール先がリンクです。安全のため削除しません。'
  }
  $reg = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($script:RegPath)
  if ($reg) {
    try { $recordedRoot = [string]$reg.GetValue('InstallLocation') }
    finally { $reg.Close() }
    if (-not (SamePath $root $recordedRoot)) {
      throw 'Windowsのインストール記録が別フォルダを指しています。削除しません。'
    }
  }
  foreach ($part in @('data','run','logs')) {
    Assert-NoReparseTree (Join-Path $root $part)
  }
  foreach ($item in @($manifest.files)) {
    $rel = [string]$item.path
    $file = CheckedRelative $rel $root
    if ((Test-Path -LiteralPath $file) -and -not (Test-Path -LiteralPath $file -PathType Leaf)) {
      throw "配布ファイルの場所がファイルではありません: $rel"
    }
    # Detect a junction/reparse point in any ancestor, including a previously
    # installed public/, scripts/, or mobile/ folder.
    $walk = $file
    while (-not (SamePath $walk $root)) {
      if (Test-Path -LiteralPath $walk) {
        $info = Get-Item -LiteralPath $walk -Force -ErrorAction Stop
        if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
          throw "管理対象パスにリンクがあります。削除しません: $walk"
        }
      }
      $walk = Split-Path -Parent $walk
    }
  }
}
# Stop only THIS installation's running server via its authenticated control path.
# Nestrill-Control.ps1 verifies the instance ID, PID and per-install secret;
# it refuses another Nestrill instance or an unrelated process on port 8767.
function StopOwnedServer([string]$root) {
  # Keep a process handle while the control file still exists. The server
  # may close its listening socket before completing SQLite shutdown.
  $ownedProcess = $null
  $controlFile = Join-Path $root 'run\nestrill-next-control.json'
  if (Test-Path -LiteralPath $controlFile -PathType Leaf) {
    try {
      $record = Get-Content -LiteralPath $controlFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($record.app -eq 'Nestrill-Next' -and [int]$record.pid -gt 0) {
        $ownedProcess = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
      }
    } catch { $ownedProcess = $null }
  }
  if (-not (PortIsBusy)) {
    # Gracefully shut-down instances can have already closed the port.
    # Do not delete files while that process is still cleaning up.
    if ($ownedProcess) {
      for ($i=0; $i -lt 40; $i++) {
        if ($ownedProcess.HasExited) { return }
        Start-Sleep -Milliseconds 250
      }
      throw 'Nestrillの終了処理が完了していません。アンインストールは実行しません。'
    }
    return
  }
  $control = Join-Path $root 'scripts\Nestrill-Control.ps1'
  if (-not (Test-Path -LiteralPath $control -PathType Leaf)) {
    throw '停止用スクリプトがありません。安全のためアンインストールを中止します。'
  }
  $out = [IO.Path]::GetTempFileName()
  $err = [IO.Path]::GetTempFileName()
  try {
    $args = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $control + '" -Action Stop'
    $process = Start-Process -FilePath $script:PsExe -ArgumentList $args -WindowStyle Hidden -PassThru -Wait `
      -RedirectStandardOutput $out -RedirectStandardError $err -ErrorAction Stop
    if ($process.ExitCode -ne 0) {
      throw 'Nestrillを正常終了できませんでした。アンインストールは実行しません。'
    }
    # Listener closure can precede the process exit and SQLite flush.
    # Never proceed while the captured process handle is still alive.
    for ($n=0; $n -lt 40; $n++) {
      $listenerClosed = -not (PortIsBusy)
      $processExited = (-not $ownedProcess) -or $ownedProcess.HasExited
      if ($listenerClosed -and $processExited) { return }
      Start-Sleep -Milliseconds 250
    }
    throw 'Nestrillの終了を確認できなかったため、アンインストールを中止しました。'
  } finally {
    Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue
  }
}

function DoUninstall {
  $root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
  $manifest = LoadManifest $root
  if (-not $manifest -or $manifest.state -ne 'installed') { throw 'このフォルダの有効なインストール記録がありません。削除しません。' }
  Assert-OwnedPackagePaths $root $manifest
  $message = "Nestrillをアンインストールします。`n`n" +
    "アプリ本体と、登録したRSS・設定・履歴などの保存データを削除します。`n`n" +
    "アンインストールしますか？"
  if (-not (Confirm $message 'Nestrill のアンインストール')) { return }
  StopOwnedServer $root
  $shell = New-Object -ComObject WScript.Shell
  $autoScript = Join-Path $root 'scripts\Nestrill-Autostart.ps1'
  if (Test-Path -LiteralPath $autoScript -PathType Leaf) {
    & $autoScript -Action DisableIfOwned | Out-Null
    if (-not $?) { throw '自動起動設定の確認に失敗しました。安全のため停止します。' }
  }
  RemoveOwnedLinks $root $shell

  # Remove every application-owned runtime store, including SQLite WAL/SHM,
  # secret sessions, copied backgrounds, AI history, and transient files.
  foreach ($part in @('data','run','logs')) {
    $folder = Join-Path $root $part
    if (Test-Path -LiteralPath $folder) {
      Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction Stop
    }
  }
  # Manifest-listed distributed files are owned by THIS installation.  An
  # edited app file is still removed after the explicit destructive consent;
  # unrelated unlisted files are NOT removed.
  $removed = 0
  $folders = @()
  foreach ($item in @($manifest.files)) {
    $rel = [string]$item.path
    $target = CheckedRelative $rel $root
    if (Test-Path -LiteralPath $target) {
      if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
        throw "配布ファイルの場所がファイルではありません: $rel"
      }
      Remove-Item -LiteralPath $target -Force -ErrorAction Stop
      $removed++
    }
    $parent = Split-Path -Parent $target
    while (-not (SamePath $parent $root)) {
      $folders += $parent
      $parent = Split-Path -Parent $parent
    }
  }
  # Remove the application's install manifest only after runtime and package
  # deletion succeeds, leaving the registry entry for retry if a failure occurs.
  RemoveUninstallRegistration $root
  $manifestPath = Join-Path $root $script:ManifestName
  if (Test-Path -LiteralPath $manifestPath) {
    Remove-Item -LiteralPath $manifestPath -Force -ErrorAction Stop
  }
  foreach ($folder in @($folders | Sort-Object -Unique | Sort-Object Length -Descending)) {
    if ((Test-Path -LiteralPath $folder -PathType Container) -and
        @(Get-ChildItem -LiteralPath $folder -Force).Count -eq 0) {
      Remove-Item -LiteralPath $folder -ErrorAction Stop
    }
  }
  $unknown = @(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop)
  if ($unknown.Count -eq 0) {
    Remove-Item -LiteralPath $root -ErrorAction Stop
    Notice "Nestrillのアンインストールが完了しました。`nアプリ本体と保存データを削除しました。" 'Nestrill'
  } else {
    Notice "Nestrill本体と利用データの削除が完了しました。`n`nインストール時の管理対象外のファイルが残っています。安全のため削除しませんでした。`n$root`n`n残存項目：$($unknown.Count) 件" 'Nestrill'
  }
}

try {
  if ($Mode -eq 'Uninstall') { DoUninstall; exit 0 }
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Nestrill セットアップ — v0.2.0'
  $form.Size = New-Object System.Drawing.Size(640,360)
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.Font = New-Object System.Drawing.Font('Yu Gothic UI',10)

  $header = New-Object System.Windows.Forms.Label
  $header.Text = 'Nestrill をインストールします'
  $header.AutoSize = $true
  $header.Location = New-Object System.Drawing.Point(24,19)
  $header.Font = New-Object System.Drawing.Font('Yu Gothic UI',13,[System.Drawing.FontStyle]::Bold)
  $form.Controls.Add($header)
  $note = New-Object System.Windows.Forms.Label
  $note.Text = '管理者権限不要。N欄に「Nestrill」と「Nestrill を終了」を登録します。'
  $note.AutoSize = $true
  $note.Location = New-Object System.Drawing.Point(24,54)
  $form.Controls.Add($note)
  $label = New-Object System.Windows.Forms.Label
  $label.Text = 'インストール先'
  $label.AutoSize = $true
  $label.Location = New-Object System.Drawing.Point(24,98)
  $form.Controls.Add($label)
  $pathBox = New-Object System.Windows.Forms.TextBox
  $pathBox.Location = New-Object System.Drawing.Point(24,123)
  $pathBox.Size = New-Object System.Drawing.Size(485,28)
  $pathBox.Text = Join-Path $env:LOCALAPPDATA 'Programs\Nestrill'
  $form.Controls.Add($pathBox)
  $browse = New-Object System.Windows.Forms.Button
  $browse.Text = '参照...'
  $browse.Location = New-Object System.Drawing.Point(522,122)
  $browse.Size = New-Object System.Drawing.Size(82,30)
  $browse.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Nestrillのインストール先フォルダを選択してください'
    $dialog.ShowNewFolderButton = $true
    if ($dialog.ShowDialog() -eq 'OK') { $pathBox.Text = $dialog.SelectedPath }
  })
  $form.Controls.Add($browse)
  $desktopBox = New-Object System.Windows.Forms.CheckBox
  $desktopBox.Text = 'デスクトップにショートカットを作成'
  $desktopBox.Checked = $true
  $desktopBox.AutoSize = $true
  $desktopBox.Location = New-Object System.Drawing.Point(24,181)
  $form.Controls.Add($desktopBox)
  $nodeLabel = New-Object System.Windows.Forms.Label
  $nodeLabel.Text = TestNodeVersion
  $nodeLabel.AutoSize = $true
  $nodeLabel.Location = New-Object System.Drawing.Point(24,222)
  $form.Controls.Add($nodeLabel)
  $nodeLink = New-Object System.Windows.Forms.LinkLabel
  $nodeLink.Text = 'Node.js公式サイト（未導入の場合）'
  $nodeLink.AutoSize = $true
  $nodeLink.Location = New-Object System.Drawing.Point(24,248)
  $nodeLink.Add_LinkClicked({ Start-Process 'https://nodejs.org/en/download/' })
  $form.Controls.Add($nodeLink)
  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = 'キャンセル'
  $cancel.Size = New-Object System.Drawing.Size(95,32)
  $cancel.Location = New-Object System.Drawing.Point(396,279)
  $cancel.Add_Click({ $form.Close() })
  $form.Controls.Add($cancel)
  $install = New-Object System.Windows.Forms.Button
  $install.Text = 'インストール'
  $install.Size = New-Object System.Drawing.Size(113,32)
  $install.Location = New-Object System.Drawing.Point(503,279)
  $install.Add_Click({
    $install.Enabled = $false
    try {
      $dest = DoInstall $pathBox.Text.Trim() $desktopBox.Checked
      ShowInstallComplete $dest
      $form.Close()
    } catch { Notice $_.Exception.Message 'インストールできませんでした' 'Error' }
    finally { $install.Enabled = $true }
  })
  $form.Controls.Add($install)
  $form.AcceptButton = $install
  $form.CancelButton = $cancel
  [void]$form.ShowDialog()
} catch { Notice $_.Exception.Message 'Nestrill セットアップエラー' 'Error'; exit 1 }
