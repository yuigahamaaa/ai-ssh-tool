@echo off
REM SSH Tool - Quick Setup Script (Windows)
REM Run this on a new machine to install dependencies and build

cd /d "%~dp0"

echo [ssh-tool] Installing dependencies...
call npm install
if errorlevel 1 (
    echo [ssh-tool] Failed to install dependencies
    exit /b 1
)

echo [ssh-tool] Building...
call npm run build
if errorlevel 1 (
    echo [ssh-tool] Failed to build
    exit /b 1
)

echo [ssh-tool] Done! Test with:
echo   node dist\cli\ssh-exec.js --help
