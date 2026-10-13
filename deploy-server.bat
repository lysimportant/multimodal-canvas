@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy-server.ps1" %*
set "DEPLOY_EXIT=%ERRORLEVEL%"

if not "%DEPLOY_EXIT%"=="0" echo Deployment failed. See the message above.
echo.
pause
exit /b %DEPLOY_EXIT%
