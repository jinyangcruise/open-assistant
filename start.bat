@echo off
echo Starting OpenCLI Smart Assistant...
echo.

REM Check if node_modules exists
if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
    echo.
)

echo Launching application...
call npm start
