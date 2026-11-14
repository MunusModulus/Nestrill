@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Nestrill-Mobile.ps1" -Action Enable
if errorlevel 1 (
  echo.
  echo [Nestrill Mobile] See the error message above.
  pause
  exit /b 1
)
exit /b 0
