@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Nestrill-Mobile-DesktopShortcuts.ps1"
if errorlevel 1 (
 echo Operation failed. See the message above.
 pause
 exit /b 1
)
exit /b 0
