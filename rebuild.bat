@echo off
echo ========================================
echo  Electron Rebuild Helper
echo ========================================
echo.

cd /d "%~dp0"

echo Step 1: Cleaning...
if exist "node_modules" (
    echo Removing node_modules...
    rmdir /s /q node_modules
)
if exist "package-lock.json" (
    del package-lock.json
)
echo.

echo Step 2: Installing dependencies...
call npm install
echo.

echo Step 3: Rebuilding native modules...
call npx electron-rebuild -v 28.0.0
echo.

echo ========================================
echo Done! You can now run: npm start
echo ========================================
pause