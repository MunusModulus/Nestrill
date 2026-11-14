@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Nestrill-Remote.ps1" -Action Stop
if errorlevel 1 (
  echo.
  echo [Nestrill Remote] Remote stop failed. Check the message above.
  pause
  exit /b 1
)
exit /b 0
