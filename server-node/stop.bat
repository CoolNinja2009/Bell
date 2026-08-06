@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo Stopping relay-server...
pm2 stop ecosystem.config.js
if %ERRORLEVEL% EQU 0 (
    echo [✓] relay-server stopped.
) else (
    echo [!] pm2 stop exited with code %ERRORLEVEL% (process may not have been running).
)
