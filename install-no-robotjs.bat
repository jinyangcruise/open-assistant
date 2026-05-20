@echo off
echo ========================================
echo  Quick Install (No Compilation)
echo ========================================
echo.
echo This version uses pure Electron APIs
echo No C++ compilation needed!
echo.

cd /d "%~dp0"

echo Step 1: Cleaning old files...
if exist "node_modules" (
    echo Removing node_modules...
    rmdir /s /q node_modules 2>nul
)
if exist "package-lock.json" (
    del package-lock.json 2>nul
)
echo.

echo Step 2: Installing dependencies...
call npm install
echo.

if %errorlevel% neq 0 (
    echo.
    echo ========================================
    echo ERROR: npm install failed!
    echo ========================================
    echo.
    echo Please check the error message above.
    echo Common issues:
    echo   1. Node.js not installed - install from https://nodejs.org
    echo   2. Network issues - check your connection
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================
echo Installation Complete!
echo ========================================
echo.
echo To start the application:
echo   npm start
echo.
echo Or double-click: start.bat
echo.
pause
