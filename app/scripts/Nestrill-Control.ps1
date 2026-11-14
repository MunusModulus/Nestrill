param(
  [ValidateSet('Start','Stop','Status')][string]$Action='Status',
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 8767
$baseUrl = 'http://127.0.0.1:8767'
$controlFile = Join-Path $root 'run\nestrill-next-control.json'
$logs = Join-Path $root 'logs'

function Read-Health {
  try {
    $r = Invoke-RestMethod -Uri "$baseUrl/api/_control/health" -Method Get -TimeoutSec 2
    if ($r.app -eq 'Nestrill-Next' -and $r.instanceId -and $r.pid) { return $r }
  } catch {}
  return $null
}
function Port-Owner {
  try { return @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1)[0] } catch {return $null}
}
function Show-Logs {
  if (Test-Path -LiteralPath $logs) {
    $items = @(Get-ChildItem -LiteralPath $logs -Filter '*-stderr.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    if ($items.Count -gt 0) { Write-Host ('Error log: ' + $items[0].FullName) }
  }
}
function Print-Port-Owner {
  $owner = Port-Owner
  if ($null -ne $owner) {
    Write-Host ('Port 8767 is in use. PID: ' + $owner.OwningProcess)
    try {
      $processInfo=Get-CimInstance Win32_Process -Filter "ProcessId=$($owner.OwningProcess)" -ErrorAction Stop
      Write-Host ('Process: ' + $processInfo.Name + '  ' + $processInfo.CommandLine)
    } catch {}
    Write-Host 'No processes were terminated.'
  } else { Write-Host 'No listener detected on port 8767.' }
}

if ($Action -eq 'Status') {
  $health=Read-Health
  if ($health) {
    Write-Host "Nestrill RUNNING  PID=$($health.pid)  Uptime=$($health.uptimeSec)s"
    try {
      $local=Get-Content -LiteralPath $controlFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($local.instanceId -eq $health.instanceId) {Write-Host 'Ownership: this project folder'}
      else {Write-Warning 'A different Nestrill instance owns the port.'}
    } catch { Write-Warning 'Local control file not available (possibly older Nestrill).' }
    Show-Logs
    exit 0
  }
  Print-Port-Owner
  Show-Logs
  exit 0
}

if ($Action -eq 'Stop') {
  $health=Read-Health
  if (-not $health) {
    if ($null -ne (Port-Owner)) {
      Write-Error 'Nestrill以外のプロセスがポート8767を使用している可能性があります。何も終了していません。'
      exit 1
    }
    Write-Host 'Nestrillはすでに停止しています。'
    exit 0
  }
  try { $local=Get-Content -LiteralPath $controlFile -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { Write-Error 'Control file missing. A legacy process may be running. No process was terminated.';exit 2 }
  if ($local.app -ne 'Nestrill-Next' -or $local.instanceId -ne $health.instanceId -or [int]$local.pid -ne [int]$health.pid -or -not $local.secret) {
    Write-Error 'Instance mismatch. Refusing to stop an unverified process.'; exit 3
  }
  try {
    $null = Invoke-RestMethod -Uri "$baseUrl/api/_control/stop" -Method Post -TimeoutSec 3 -ContentType 'application/json' -Headers @{'x-nestrill-control'=[string]$local.secret} -Body '{}'
  } catch { Write-Error ('Stop request failed: ' + $_.Exception.Message); exit 4 }
  Write-Host 'Graceful shutdown requested. Waiting for RSS operations to finish...'
  for ($i=0; $i -lt 150; $i++) {
    Start-Sleep -Milliseconds 250
    $current=Read-Health
    if (-not $current -or $current.instanceId -ne $health.instanceId) {
      Write-Host 'Nestrill stopped successfully.'
      Show-Logs
      exit 0
    }
  }
  Write-Warning 'Server is still running after 38 seconds. See log. It was NOT force-killed.'
  Show-Logs
  exit 5
}

# Start: refusing duplicate starts prevents a second server with a different data directory.
$health=Read-Health
if ($health) {
  try {$local=Get-Content -LiteralPath $controlFile -Raw -Encoding UTF8 | ConvertFrom-Json} catch {$local=$null}
  if ($local -and $local.instanceId -eq $health.instanceId) {
    Write-Host ('Nestrill is already running. PID=' + $health.pid)
    if (-not $NoBrowser) { Start-Process $baseUrl }
    exit 0
  }
  Write-Error 'Another Nestrill instance is using port 8767. No new process started.'
  exit 6
}
if ($null -ne (Port-Owner)) {
  Print-Port-Owner
  Write-Error 'Port 8767 is occupied. No new process started.'
  exit 7
}
$node=Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {Write-Error 'Node.js was not found in PATH. Node.js 22.16+ is required.';exit 8}
try {
  $v=([version]((& $node.Source --version).Trim().TrimStart('v')))
  if ($v.Major -lt 22 -or ($v.Major -eq 22 -and $v.Minor -lt 16)) {throw 'Node.js 22.16 or newer is required'}
} catch {Write-Error ('Node.js version check failed: '+$_.Exception.Message);exit 9}
if (-not (Test-Path -LiteralPath (Join-Path $root 'server.js'))) {Write-Error 'server.js missing';exit 10}
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$outLog=Join-Path $logs ("nestrill-$stamp-stdout.log")
$errLog=Join-Path $logs ("nestrill-$stamp-stderr.log")
Write-Host ('Starting Nestrill with ' + $node.Source)
try {
  # Force loopback binding: no LAN/internet exposure from this launcher.
  $proc=Start-Process -FilePath $node.Source -ArgumentList @('--experimental-sqlite','server.js') -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
} catch {Write-Error ('Node.js start failed: '+$_.Exception.Message);exit 11}
for ($i=0; $i -lt 48; $i++) {
  Start-Sleep -Milliseconds 250
  $health=Read-Health
  if ($health -and [int]$health.pid -eq $proc.Id) {
    Write-Host ('Nestrill started. PID=' + $proc.Id)
    Write-Host ('Browser: '+$baseUrl)
    Write-Host ('Output log: '+$outLog)
    Write-Host ('Error log: '+$errLog)
    if (-not $NoBrowser) { Start-Process $baseUrl }
    exit 0
  }
  $proc.Refresh()
  if ($proc.HasExited) { break }
}
Write-Warning 'Nestrill did not pass its startup health check.'
Print-Port-Owner
Write-Host ('Output log: '+$outLog)
Write-Host ('Error log: '+$errLog)
if (Test-Path $errLog) {Get-Content -LiteralPath $errLog -Tail 18 | ForEach-Object {Write-Host $_}}
exit 12
