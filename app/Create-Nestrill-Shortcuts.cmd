@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Nestrill-Shortcuts.ps1" -Action Create
if errorlevel 1 (
  echo.
  echo [Nestrill] Shortcut setup failed. No existing shortcuts were replaced.
  pause
  exit /b 1
)
echo.
echo [Nestrill] Shortcut setup completed.
pause
exit /b 0
