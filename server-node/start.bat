@echo off
setlocal enabledelayedexpansion
title Relay Controller Server

:: -- 1. Verify Node.js -------------------------------------------------
where node >nul 2>&1 || (
    echo Node.js not found. Install from https://nodejs.org/
    exit /b 1
)

:: -- 2. Verify Git -----------------------------------------------------
where git >nul 2>&1 || (
    echo Git not found. Install from https://git-scm.com/
    exit /b 2
)

:: -- 3. Install PM2 if missing -----------------------------------------
where pm2 >nul 2>&1 || (
    echo PM2 not found - installing...
    call npm install -g pm2 2>nul || (
        echo npm install failed. Try: npm install -g pm2
        exit /b 3
    )
)

:: -- 4. Verify git repository + remote ---------------------------------
git rev-parse --git-dir >nul 2>&1 || (
    echo Not a git repository.
    exit /b 4
)

git remote get-url origin >nul 2>&1 || (
    echo Setting git remote origin...
    git remote add origin https://github.com/CoolNinja2009/Bell.git
)

:: -- 5. Check GitHub for updates ---------------------------------------
echo Checking for updates...
for /f "tokens=1" %%s in ('git ls-remote origin refs/heads/main 2^>nul') do set REMOTE_SHA=%%s
for /f "tokens=*" %%s in ('git rev-parse HEAD 2^>nul') do set LOCAL_SHA=%%s

if "%REMOTE_SHA%"=="" (
    echo Warning: Could not reach GitHub - starting with current version.
    goto start_server
)

if "%LOCAL_SHA%"=="%REMOTE_SHA%" (
    echo Already up-to-date.
    goto start_server
)

:: -- 6. Update from GitHub ---------------------------------------------
echo New version found - updating...
echo %LOCAL_SHA:~0,7% -^> %REMOTE_SHA:~0,7%

:: Check if package files changed between commits
for /f "tokens=*" %%f in ('git diff --name-only %LOCAL_SHA% %REMOTE_SHA% 2^>nul') do (
    echo %%f | findstr /r "package.json package-lock.json" >nul && set DEPS_CHANGED=1
)

git fetch origin || (
    echo Fetch failed - starting with current version.
    goto start_server
)

git reset --hard origin/main || (
    echo Reset failed - starting with current version.
    goto start_server
)

if "%DEPS_CHANGED%"=="1" (
    echo Dependencies changed - installing...
    call npm ci || call npm install || (
        echo Dependency install failed.
        exit /b 5
    )
)

echo Update complete.

:: -- 7. Start server ---------------------------------------------------
:start_server
if not exist "node_modules\" (
    echo Installing dependencies...
    call npm ci 2>nul || call npm install || (
        echo Dependency install failed.
        exit /b 5
    )
)

pm2 list 2>nul | findstr /c:"relay-server" >nul && (
    echo Restarting relay-server...
    call pm2 restart ecosystem.config.js --update-env
) || (
    echo Starting relay-server...
    call pm2 start ecosystem.config.js
)

if %ERRORLEVEL% neq 0 (
    echo PM2 failed to start. Check: pm2 logs relay-server
    exit /b 6
)

echo.
echo Server running at http://localhost:8080
echo Live logs below - Ctrl+C to exit (server stays running).
echo ------------------------------------------------------------
pm2 logs relay-server --raw
