# Windows installed font family names only. No font binary data is sent or copied.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName System.Drawing
  $families = New-Object System.Drawing.Text.InstalledFontCollection
  $names = @($families.Families | ForEach-Object { $_.Name } | Where-Object { $_ } | Sort-Object -Unique)
  ConvertTo-Json -InputObject $names -Compress -Depth 2
} catch {
  # Do not fail the entire reader if installed font enumeration is unavailable.
  Write-Output '[]'
}
