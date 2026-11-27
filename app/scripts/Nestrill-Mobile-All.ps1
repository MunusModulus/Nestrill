param([Parameter(Mandatory=$true)][ValidateSet('On','Off')][string]$Action)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$ps=Join-Path $PSHOME 'powershell.exe'
$mobile=Join-Path $root 'scripts\Nestrill-Mobile.ps1'
$remote=Join-Path $root 'scripts\Nestrill-Remote.ps1'
$state=Join-Path $root 'run\Nestrill-Remote-Access.json'
$lock=$null; $locked=$false; $code=0
function Run-Existing([string]$file,[string]$verb) {
  & $ps -NoProfile -ExecutionPolicy Bypass -File $file -Action $verb
  if($LASTEXITCODE -ne 0){throw "既存の接続処理が失敗しました: $([IO.Path]::GetFileName($file)) $verb"}
}
try {
  $lock=New-Object System.Threading.Mutex($false,'Local\NestrillMobileDesktopShortcuts-v1')
  try {$locked=$lock.WaitOne(0)} catch [System.Threading.AbandonedMutexException] {$locked=$true}
  if(-not $locked){throw '別のON/OFF操作が実行中です。'}
  foreach($p in @($mobile,$remote)) {if(-not (Test-Path -LiteralPath $p -PathType Leaf)){throw "Nestrillの標準インストール先に必要なファイルがありません: $p"}}
  if($Action -eq 'On') {
    if(Test-Path -LiteralPath $state) {
      Run-Existing $remote 'Status'
      throw '外出先接続の設定記録が既にあります。再開始する場合はOFFを実行してからONにしてください。'
    }
    # The existing Status action verifies the running instance and never changes it.
    $status=@(& $ps -NoProfile -ExecutionPolicy Bypass -File $mobile -Action Status 2>&1)
    $statusCode=$LASTEXITCODE
    if($statusCode -eq 0 -and ($status -join "`n") -match '(?im)^Mobile enabled:\s*True\s*$') {
      Write-Host '既にLAN接続が有効です。接続コードを維持します。'
    } else {
      Run-Existing $mobile 'Enable'
    }
    Run-Existing $remote 'Start'
    Write-Host '[PASS] スマホ接続と外出先接続を開始しました。' -ForegroundColor Green
  } else {
    Run-Existing $remote 'Stop'
    # If the PC server has already stopped, no mobile listener remains in that server.
    # Do not assume this on errors: use the existing Disable command and report failure.
    Run-Existing $mobile 'Disable'
    Write-Host '[PASS] 外出先接続とLAN接続を停止しました。PC版は維持されます。' -ForegroundColor Green
  }
} catch {
  $code=1
  Write-Host ('[FAIL] '+$_.Exception.Message) -ForegroundColor Red
  Write-Host 'ONに失敗した場合、LAN接続だけが有効なことがあります。不要ならOFFを実行してください。'
  Write-Host 'OFFに失敗した場合は停止済みと判断せず、表示されたエラーを確認してください。'
} finally {
  if($locked){$lock.ReleaseMutex()}
  if($null -ne $lock){$lock.Dispose()}
}
exit $code
