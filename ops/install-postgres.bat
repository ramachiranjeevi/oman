@echo off
rem Run as Administrator: right-click this file -> Run as administrator
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-postgres.ps1"
echo.
pause
