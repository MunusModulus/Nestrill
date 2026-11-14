@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Nestrill-Control.ps1" -Action Start
if errorlevel 1 (
  echo.
  echo [Nestrill] See the diagnostic message above.
  pause
  exit /b 1
)
