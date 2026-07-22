@echo off
chcp 65001 >nul 2>&1
title Nexus Agent - One-Click Launcher

REM Try PowerShell 7 (pwsh), fall back to Windows PowerShell
where pwsh >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
)

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ============================================
    echo  Launch failed. Exit code: %ERRORLEVEL%
    echo ============================================
    echo.
    pause
) else (
    echo.
    pause
)
