$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$store=Join-Path $root 'run\nestrill-mobile-sessions-v1.json'
try {
  if(-not (Test-Path -LiteralPath $store)){
    Write-Host '[PASS] 有効な保存済みログインはありません。' -ForegroundColor Green
    exit 0
  }
  Write-Host 'Nestrill Mobileのすべての端末の保存済みログインを失効させます。' -ForegroundColor Yellow
  Write-Host '記事・既読・お気に入り・AI推薦・接続コードは変更しません。'
  $answer=Read-Host '実行する場合は YES と入力してください'
  if($answer -cne 'YES'){Write-Host '中止しました。';exit 0}
  Remove-Item -LiteralPath $store -Force -ErrorAction Stop
  Write-Host '[PASS] 保存済みのすべての端末のログインを無効化しました。' -ForegroundColor Green
  exit 0
}catch{
  Write-Host ('[FAIL] '+$_.Exception.Message) -ForegroundColor Red
  exit 1
}
