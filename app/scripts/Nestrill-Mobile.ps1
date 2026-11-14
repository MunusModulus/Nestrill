param([ValidateSet('Enable','Disable','Status')][string]$Action='Enable')
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$controlFile=Join-Path $root 'run\nestrill-next-control.json'
$accessFile=Join-Path $root 'run\Nestrill-Mobile-Access.txt'
$api='http://127.0.0.1:8767'
function Get-Health {
  try { $h=Invoke-RestMethod -Uri "$api/api/_control/health" -TimeoutSec 3; if($h.app -eq 'Nestrill-Next' -and $h.instanceId){return $h} } catch {}
  return $null
}
try {
  $health=Get-Health
  if(-not $health -and $Action -eq 'Enable') {
    Write-Host 'Nestrill is not running. Starting the PC server...'
    & (Join-Path $root 'scripts\Nestrill-Control.ps1') -Action Start
    if($LASTEXITCODE -ne 0) {throw 'PC版の起動に失敗しました。'}
    $health=Get-Health
  }
  if(-not $health){throw 'PC版が起動していません。スマホ接続を操作できません。'}
  if(-not (Test-Path -LiteralPath $controlFile)){throw '起動中のNestrillの管理ファイルがありません。'}
  $control=Get-Content -LiteralPath $controlFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if($control.app -ne 'Nestrill-Next' -or $control.instanceId -ne $health.instanceId -or [int]$control.pid -ne [int]$health.pid -or -not $control.secret){throw '別のNestrillが起動しています。操作を中断しました。'}
  $headers=@{'x-nestrill-control'=[string]$control.secret}
  $hostIp=''
  if($Action -eq 'Enable'){
    $all=@(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object {
      -not $_.SkipAsSource -and $_.AddressState -eq 'Preferred' -and
      (($_.IPAddress -match '^10\.') -or ($_.IPAddress -match '^192\.168\.') -or
       ($_.IPAddress -match '^172\.(1[6-9]|2[0-9]|3[01])\.'))
    } | Sort-Object -Property InterfaceMetric,IPAddress -Unique)
    if($all.Count -eq 0){throw '利用可能なプライベートLAN IPv4アドレスがありません。Wi-Fi接続を確認してください。'}
    if($all.Count -eq 1){$hostIp=$all[0].IPAddress}
    else {
      Write-Host 'スマホと同じWi-Fi/LANにあるIPを選んでください:'
      for($i=0;$i -lt $all.Count;$i++){Write-Host ('  [{0}] {1} ({2})' -f ($i+1),$all[$i].IPAddress,$all[$i].InterfaceAlias)}
      $num=Read-Host '番号を入力'
      if($num -notmatch '^\d+$' -or [int]$num -lt 1 -or [int]$num -gt $all.Count){throw '番号が不正です。'}
      $hostIp=$all[[int]$num-1].IPAddress
    }
  }
  $data=@{action=($Action.ToLower())}
  if($Action -eq 'Enable'){$data.action='enable';$data.host=$hostIp}
  if($Action -eq 'Disable'){$data.action='disable'}
  $result=Invoke-RestMethod -Uri "$api/api/_control/mobile" -Method Post -TimeoutSec 8 -Headers $headers -ContentType 'application/json' -Body ($data|ConvertTo-Json -Compress)
  if($Action -eq 'Enable'){
    $message=@"
Nestrill Mobile  (LAN only)

スマホとPCを同じWi-Fiに接続してください。

スマホで開くURL:
$($result.url)

接続コード (8桁):
$($result.pin)

PC版は従来どおり http://127.0.0.1:8767 で動作します。
このコードは接続を停止・PC版終了するまで有効です。
接続の停止: Stop-Nestrill-Mobile.cmd

※ Windows Defender Firewall が接続を尋ねたら
  自宅の「プライベート ネットワーク」のみ許可してください。
  パブリック ネットワークは許可しないでください。
※ HTTPで接続するため、信頼できる家庭内Wi-Fiでのみ使用してください。
"@
    New-Item -ItemType Directory -Force (Split-Path $accessFile -Parent) | Out-Null
    [System.IO.File]::WriteAllText($accessFile,$message,[System.Text.UTF8Encoding]::new($true))
    Write-Host '[PASS] スマホ接続を有効にしました。' -ForegroundColor Green
    Write-Host ('URL: '+$result.url)
    Write-Host ('PIN: '+$result.pin)
    Start-Process -FilePath notepad.exe -ArgumentList ('"'+$accessFile+'"')
  }elseif($Action -eq 'Disable'){
    Remove-Item -LiteralPath $accessFile -Force -ErrorAction SilentlyContinue
    Write-Host '[PASS] スマホ接続を停止しました。PC版は起動したままです。' -ForegroundColor Green
  }else{Write-Host ('Mobile enabled: '+$result.enabled);if($result.enabled) {Write-Host ('URL: '+$result.url)}}
  exit 0
}catch{
  Write-Host ('[FAIL] '+$_.Exception.Message) -ForegroundColor Red
  exit 1
}
