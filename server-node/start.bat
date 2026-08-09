@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

if /i "%~1"=="--update" (
    echo ==^> Fetching updates...
    git fetch origin
    echo ==^> Resetting to origin/main...
    git reset --hard origin/main
    echo ==^> Starting server...
    node bootstrap.js
) else if /i "%~1"=="--restart" (
    echo ==^> Restarting server...
    pm2 restart relay-server 2>nul || node bootstrap.js
    echo ==^> Done.
) else (
    node bootstrap.js
)
