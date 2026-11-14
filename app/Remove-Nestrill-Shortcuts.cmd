@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Nestrill-Shortcuts.ps1" -Action Remove
if errorlevel 1 (
  echo.
  echo [Nestrill] Shortcut removal failed.
  pause
  exit /b 1
)
echo.
echo [Nestrill] Shortcuts removed. Application data was not deleted.
pause
exit /b 0
