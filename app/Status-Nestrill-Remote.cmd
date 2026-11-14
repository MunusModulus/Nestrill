@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Nestrill-Remote.ps1" -Action Status
if errorlevel 1 (
  echo.
  echo [Nestrill Remote] Remote status failed.
)
pause
exit /b 0
