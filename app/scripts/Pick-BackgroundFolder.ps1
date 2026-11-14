param([string]$InitialDirectory = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Nestrill - 背景フォルダを選択してください'
$dialog.ShowNewFolderButton = $false
try {
    if ($InitialDirectory -and (Test-Path -LiteralPath $InitialDirectory -PathType Container)) {
        $dialog.SelectedPath = (Resolve-Path -LiteralPath $InitialDirectory).Path
    }
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)
        [Console]::Write('SELECTED:' + [System.Convert]::ToBase64String($bytes))
    } else {
        [Console]::Write('CANCELLED')
    }
} finally {
    $dialog.Dispose()
}
