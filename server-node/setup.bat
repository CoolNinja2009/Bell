@echo off
setlocal enabledelayedexpansion
title Bell System — One-Time Setup
chcp 65001 >nul 2>&1

echo.
echo ========================================================
echo       Relay Controller Server — Initial Setup
echo ========================================================
echo.
echo This installs Node.js and Git (if missing), then
echo clones the repository and runs the first bootstrap.
echo Run this ONCE on a new school PC.
echo.

:: ── Detect: are we inside an existing repo? ──────────────
set "REPO_URL=https://github.com/CoolNinja2009/Bell.git"
set "REPO_DIR=%USERPROFILE%\Bell"

if exist "%~dp0bootstrap.js" (
    echo [i] Detected existing repository.
    pushd "%~dp0.."
    set "REPO_DIR=%CD%"
    popd
    set "ALREADY_CLONED=1"
) else if exist "%REPO_DIR%\server-node\bootstrap.js" (
    echo [i] Detected existing repository at %REPO_DIR%
    set "ALREADY_CLONED=1"
) else (
    set "ALREADY_CLONED=0"
)

:: ── Check for admin ────────────────────────────────────────
net session >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [!] Not running as Administrator.
    echo     Installers may prompt for elevation.
    echo.
)

:: ── Detect winget ──────────────────────────────────────────
where winget >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [X] winget not found.
    echo     This PC needs Windows 10 22H2^+ or Windows 11.
    echo.
    echo Manual setup:
    echo   1. Install Node.js LTS from https://nodejs.org/
    echo   2. Install Git from https://git-scm.com/
    if "%ALREADY_CLONED%"=="0" (
        echo   3. git clone %REPO_URL%
    )
    echo   4. cd Bell\server-node ^&^& node bootstrap.js
    echo.
    pause
    exit /b 1
)

:: ── Install Node.js ────────────────────────────────────────
echo [1/3] Checking Node.js...
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   Installing Node.js LTS...
    winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
    if %ERRORLEVEL% neq 0 (
        echo   [X] Install failed. Get it from https://nodejs.org/
        pause
        exit /b 1
    )
    echo   [✓] Node.js installed — restarting script for PATH refresh...
    call "%~f0"
    exit /b 0
) else (
    for /f "tokens=*" %%v in ('node --version') do echo   [✓] Node.js %%v
)

:: ── Install Git ────────────────────────────────────────────
echo [2/3] Checking Git...
where git >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   Installing Git...
    winget install --id Git.Git --accept-source-agreements --accept-package-agreements --silent
    if %ERRORLEVEL% neq 0 (
        echo   [X] Install failed. Get it from https://git-scm.com/
        pause
        exit /b 1
    )
    echo   [✓] Git installed — restarting script for PATH refresh...
    call "%~f0"
    exit /b 0
) else (
    for /f "tokens=*" %%v in ('git --version') do echo   [✓] Git %%v
)

:: ── Clone repository (if needed) ───────────────────────────
echo [3/3] Checking repository...
if "%ALREADY_CLONED%"=="1" (
    echo   [✓] Repository already present.
) else (
    echo   Cloning to %REPO_DIR%...
    git clone "%REPO_URL%" "%REPO_DIR%"
    if %ERRORLEVEL% neq 0 (
        echo   [X] Clone failed. Check your internet connection.
        pause
        exit /b 1
    )
    echo   [✓] Repository cloned.
)

:: ── Run bootstrap ──────────────────────────────────────────
echo.
echo ── Running bootstrap ────────────────────────────────────
echo.
cd /d "%REPO_DIR%\server-node"
node bootstrap.js

echo.
echo ========================================================
echo   Setup complete.
echo.
echo   ADD TO STARTUP (so the server starts on every boot):
echo     Win+R ^> shell:startup ^> New Shortcut
echo     Target: %REPO_DIR%\server-node\start.bat
echo ========================================================
echo.
pause
