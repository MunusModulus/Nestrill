@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Nestrill-Autostart.ps1" -Action Disable
set "rc=%ERRORLEVEL%"
echo.
if not "%rc%"=="0" echo [Nestrill] Autostart operation failed. See the message above.
pause
exit /b %rc%
