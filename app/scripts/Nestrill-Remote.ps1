param([ValidateSet('Start','Stop','Status')][string]$Action='Start')
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$stateFile=Join-Path $root 'run\Nestrill-Remote-Access.json'
$noteFile=Join-Path $root 'run\Nestrill-Remote-Access.txt'
$bridge=Join-Path $root 'mobile\remote-bridge.js'
$port=18768

function Find-Tailscale {
  $candidates=@('C:\Program Files\Tailscale\tailscale.exe','C:\Program Files (x86)\Tailscale\tailscale.exe')
  $command=Get-Command 'tailscale.exe' -ErrorAction SilentlyContinue
  if($command){$candidates=@($command.Source)+$candidates}
  foreach($p in $candidates){if(Test-Path -LiteralPath $p){return $p}}
  throw 'Tailscaleが未インストールです。PCとスマホにインストールし、同じアカウントでログインしてください。'
}
function Get-ServeStatus([string]$exe){
  $output=@(& $exe serve status 2>&1)
  if($LASTEXITCODE -ne 0){throw ('tailscale serve statusに失敗しました: '+($output -join ' '))}
  return ($output -join "`n")
}
function Is-ServeEmpty([string]$s){
  return ([string]::IsNullOrWhiteSpace($s) -or $s.Trim() -eq '{}' -or $s -match '(?i)No serve config')
}
function Check-RemoteBridgeProcess([int]$id){
  if($id -le 0){return $null}
  $p=Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
  if(-not $p){return $null}
  if(-not $p.CommandLine -or $p.CommandLine.IndexOf($bridge,[StringComparison]::OrdinalIgnoreCase) -lt 0){
    throw "PID $id はNestrillの中継プロセスではありません。停止しません。"
  }
  return $p
}
function Remove-RemoteBridgeProcess([int]$id){
  $p=Check-RemoteBridgeProcess $id
  if($p){Stop-Process -Id $id -Force -ErrorAction Stop}
}
function Get-MobileState {
  $api='http://127.0.0.1:8767'
  $h=Invoke-RestMethod -Uri "$api/api/_control/health" -TimeoutSec 3
  if($h.app -ne 'Nestrill-Next' -or -not $h.instanceId){throw 'Nestrillが起動していません。'}
  $f=Join-Path $root 'run\nestrill-next-control.json'
  if(-not (Test-Path -LiteralPath $f)){throw 'Nestrillの管理ファイルがありません。'}
  $c=Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json
  if($c.instanceId -ne $h.instanceId -or $c.app -ne 'Nestrill-Next' -or
    [int]$c.pid -ne [int]$h.pid -or -not $c.secret){throw '異なるNestrillが起動中です。'}
  $headers=@{'x-nestrill-control'=[string]$c.secret}
  $r=Invoke-RestMethod -Uri "$api/api/_control/mobile" -Headers $headers -Method Post -ContentType 'application/json' -Body '{"action":"status"}' -TimeoutSec 5
  if(-not $r.enabled -or -not $r.host -or -not $r.pin){
    throw '先にStart-Nestrill-Mobile.cmdでスマホ接続を有効にしてください。'
  }
  return $r
}
function Get-TailnetDns([string]$exe){
  $json=@(& $exe status --json 2>&1)
  if($LASTEXITCODE -ne 0){throw 'Tailscaleが起動・ログイン済みか確認してください。'}
  $s=($json -join "`n") | ConvertFrom-Json
  if($s.BackendState -ne 'Running' -or -not $s.Self.DNSName){
    throw 'Tailscaleが未接続です。PCでログインし、接続をONにしてください。'
  }
  $dns=([string]$s.Self.DNSName).TrimEnd('.').ToLowerInvariant()
  if($dns -notmatch '^([a-z0-9-]+\.)+[a-z0-9-]+\.ts\.net$'){
    throw 'TailscaleのMagicDNS名を検証できませんでした。'
  }
  return $dns
}
function Check-BridgeHealth {
  try {
    $x=Invoke-RestMethod -Uri 'http://127.0.0.1:18768/_nestrill_bridge_health' -TimeoutSec 2
    return ($x.app -eq 'Nestrill-Remote-Bridge' -and $x.active)
  }catch{return $false}
}

try{
  if($Action -eq 'Status'){
    if(Test-Path -LiteralPath $stateFile){
      $v=Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
      Write-Host ('設定済み: '+$v.url)
      Write-Host ('ローカル中継: '+(Check-BridgeHealth))
      $ts=Find-Tailscale
      Write-Host (Get-ServeStatus $ts)
    }else{Write-Host 'Nestrillの外出先接続は開始されていません。'}
    exit 0
  }
  if($Action -eq 'Stop'){
    if(-not (Test-Path -LiteralPath $stateFile)){
      Write-Host '[PASS] Nestrillの外出先接続は停止済みです。' -ForegroundColor Green
      exit 0
    }
    $v=Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if($v.app -ne 'Nestrill-Fix85' -or [int]$v.bridgePort -ne $port){throw '設定ファイルの内容が不正です。'}
    $ts=Find-Tailscale
    $serve=Get-ServeStatus $ts
    if(-not (Is-ServeEmpty $serve)){
      if($serve -notmatch '127\.0\.0\.1:18768'){
        throw '現在のServe設定がFix85の中継と一致しません。変更せず停止します。'
      }
      & $ts serve --https=443 off
      if($LASTEXITCODE -ne 0){throw 'Tailscale Serveの停止に失敗しました。中継は維持します。'}
      $after=Get-ServeStatus $ts
      if($after -match '127\.0\.0\.1:18768'){throw 'Tailscale Serveがまだ有効です。中継は停止しません。'}
    }
    Remove-RemoteBridgeProcess ([int]$v.pid)
    Remove-Item -LiteralPath $stateFile,$noteFile -Force -ErrorAction SilentlyContinue
    Write-Host '[PASS] Nestrillの外出先接続を停止しました。自宅LAN接続とPC版は維持されます。' -ForegroundColor Green
    exit 0
  }
  if(Test-Path -LiteralPath $stateFile){throw '既に外出先接続の起動記録があります。Stop-Nestrill-Remote.cmdで停止してから開始してください。'}
  $ts=Find-Tailscale
  $dns=Get-TailnetDns $ts
  $serve=Get-ServeStatus $ts
  if(-not (Is-ServeEmpty $serve)){
    throw 'このPCには既存のTailscale Serve設定があります。上書き防止のため停止しました。'
  }
  $mobile=Get-MobileState
  $node=Get-Command node.exe -ErrorAction Stop
  if(-not (Test-Path -LiteralPath $bridge)){throw '中継プログラムがありません。Nestrillの配布ファイルを確認してください。'}
  if(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue){
    throw 'ローカル18768番ポートが既に使用されています。'
  }
  $p=$null
  $startedServe=$false
  try{
    # Only node.exe is started in the background; the proxy itself never has LAN listen access.
    $argsText='"'+$bridge+'" '+$mobile.host+' '+$dns
    $p=Start-Process -FilePath $node.Source -ArgumentList $argsText -WorkingDirectory $root -WindowStyle Hidden -PassThru
    $ready=$false
    for($i=0;$i -lt 20;$i++){
      Start-Sleep -Milliseconds 200
      if(Check-BridgeHealth){$ready=$true;break}
      if($p.HasExited){break}
    }
    if(-not $ready){throw 'ローカル中継の起動を確認できませんでした。'}
    Write-Host 'Tailscale ServeのHTTPS接続を有効化します（公開Funnelは使いません）。'
    & $ts serve --bg --https=443 'http://127.0.0.1:18768'
    if($LASTEXITCODE -ne 0){throw 'Tailscale Serveを有効化できませんでした。初回はHTTPS利用の承認が必要な場合があります。'}
    $startedServe=$true
    $check=Get-ServeStatus $ts
    if($check -notmatch '127\.0\.0\.1:18768'){
      throw 'Tailscale Serveの接続先を検証できませんでした。'
    }
    $url="https://$dns/mobile/"
    New-Item -ItemType Directory -Path (Split-Path $stateFile -Parent) -Force | Out-Null
    $v=@{app='Nestrill-Fix85';pid=[int]$p.Id;bridgePort=$port;dns=$dns;lanHost=[string]$mobile.host;url=$url}
    [System.IO.File]::WriteAllText($stateFile,($v|ConvertTo-Json -Compress),[System.Text.UTF8Encoding]::new($true))
    $msg=@"
Nestrill Mobile - 外出先アクセス（Tailscale Serve / tailnet限定）

スマホ側でTailscaleをONにしてください（PCと同じアカウント）。
スマホから開くURL:
$url

接続コード（LAN版と共通・8桁）:
$($mobile.pin)

※ このURLはインターネットへ一般公開されません。
※ 自宅PC、Nestrill PC版・Mobile版、Tailscaleが起動している必要があります。
※ 終了時は Stop-Nestrill-Remote.cmd を実行してください。
※ Stop-Nestrill-Mobile.cmdを使う前に外出先接続を停止してください。
※ ルーターのポート開放やTailscale Funnelは不要です。
"@
    [System.IO.File]::WriteAllText($noteFile,$msg,[System.Text.UTF8Encoding]::new($true))
    Write-Host '[PASS] Nestrill remote mobile access started.' -ForegroundColor Green
    Write-Host ('URL: '+$url)
    Start-Process -FilePath notepad.exe -ArgumentList ('"'+$noteFile+'"')
    exit 0
  }catch{
    # Even a failed CLI invocation can leave Serve configured. It was empty before Start.
    try{
      $current=Get-ServeStatus $ts
      if($current -match '127\.0\.0\.1:18768'){& $ts serve --https=443 off | Out-Host}
    }catch{}

    if($p){try{Remove-RemoteBridgeProcess ([int]$p.Id)}catch{}}
    throw
  }
}catch{
  Write-Host ('[FAIL] '+$_.Exception.Message) -ForegroundColor Red
  exit 1
}
