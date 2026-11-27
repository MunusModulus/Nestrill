$ErrorActionPreference='Stop'
try {
  $root=Split-Path -Parent $PSScriptRoot
  $desktop=[Environment]::GetFolderPath('DesktopDirectory')
  $ps=Join-Path $PSHOME 'powershell.exe'
  $target=Join-Path $PSScriptRoot 'Nestrill-Mobile-All.ps1'
  $legacy=Join-Path $env:LOCALAPPDATA 'Nestrill-Mobile-DesktopShortcuts\Nestrill-Mobile-All.ps1'
  $standard=Join-Path $env:LOCALAPPDATA 'Programs\Nestrill'
  if(-not $desktop -or -not (Test-Path -LiteralPath $desktop -PathType Container)){throw 'デスクトップが見つかりません。'}
  foreach($p in @($target,(Join-Path $root 'Start-Nestrill-Mobile-All.cmd'),(Join-Path $root 'Stop-Nestrill-Mobile-All.cmd'))){if(-not (Test-Path -LiteralPath $p -PathType Leaf)){throw "必要なファイルがありません: $p"}}
  $shell=New-Object -ComObject WScript.Shell
  $items=@(foreach($action in @('On','Off')){
    $name=if($action -eq 'On'){'Nestrill スマホ接続 ON.lnk'}else{'Nestrill スマホ接続 OFF.lnk'}
    $path=Join-Path $desktop $name
    $cmdName=if($action -eq 'On'){'Start-Nestrill-Mobile-All.cmd'}else{'Stop-Nestrill-Mobile-All.cmd'}
    $destination=Join-Path $root $cmdName
    $keep=$false
    if(Test-Path -LiteralPath $path){
      $link=$shell.CreateShortcut($path)
      if($link.TargetPath -eq $destination -and -not ([string]$link.Arguments).Trim()){$keep=$true}
      elseif($root -eq $standard -and $link.TargetPath -eq $ps -and $link.Arguments -eq ('-NoProfile -ExecutionPolicy Bypass -File "'+$legacy+'" -Action '+$action) -and (Test-Path -LiteralPath $legacy -PathType Leaf) -and (Get-FileHash -LiteralPath $legacy -Algorithm SHA256).Hash -eq 'EEBC6A109442C89341B1FF5D628FE16C78B7252E164E69C53CE3752F32B7DF61'){$keep=$true}
      else{throw "同名の別ショートカットがあります。上書きしません: $path"}
    }
    [pscustomobject]@{Path=$path;Target=$destination;Keep=$keep}
  })
  foreach($item in $items){
    if(-not $item.Keep){
      if(Test-Path -LiteralPath $item.Path){throw "同名のショートカットが作成されました: $($item.Path)"}
      $link=$shell.CreateShortcut($item.Path)
      $link.TargetPath=$item.Target
      $link.Arguments=''
      $link.WorkingDirectory=$root
      $link.IconLocation=(Join-Path $root 'assets\Nestrill.ico')+',0'
      $link.Description='Nestrill LAN + Tailscale mobile access'
      $link.Save()
      $verify=$shell.CreateShortcut($item.Path)
      if($verify.TargetPath -ne $item.Target -or ([string]$verify.Arguments).Trim()){throw 'ショートカットの作成確認に失敗しました。'}
    }
    Write-Host ('[PASS] '+$item.Path)
  }
  exit 0
}catch{Write-Host ('[FAIL] '+$_.Exception.Message) -ForegroundColor Red;exit 1}
