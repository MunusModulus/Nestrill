@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Nestrill-Control.ps1" -Action Stop
exit /b %ERRORLEVEL%
