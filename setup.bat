@echo off
chcp 65001 >nul
echo ============================================
echo   Aemeath Desktop Agent - Setup
echo ============================================
echo.

echo [1/4] Checking Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Please install Node.js first: https://nodejs.org
    pause
    exit /b 1
)
echo [OK] Node.js found

echo [2/4] Checking Python...
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo Please install Python 3.10+: https://python.org
    pause
    exit /b 1
)
echo [OK] Python found

echo [3/4] Installing Python dependencies...
pip install -r requirements.txt
if %errorlevel% neq 0 (
    pip3 install -r requirements.txt
)
echo [OK] Python dependencies installed

echo [4/4] Installing Electron dependencies...
cd electron-app
call npm install
cd ..
echo [OK] Electron dependencies installed

echo.
echo ============================================
echo  Setup Complete!
echo ============================================
echo.
echo  Next steps:
echo  1. Edit electron-app/config.json
echo     Fill in your DeepSeek API Key
echo  2. Run: cd electron-app ^&^& npm start
echo.
pause
