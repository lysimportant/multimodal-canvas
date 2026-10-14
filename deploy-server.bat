@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Multimodal Canvas - Local Package
echo Building a local package for manual upload...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy-server.ps1" %*
set "PACKAGE_EXIT=%ERRORLEVEL%"

if not "%PACKAGE_EXIT%"=="0" echo Packaging failed. See the message above.
echo.
pause
exit /b %PACKAGE_EXIT%
