@echo off
chcp 65001 >nul
echo ============================================
echo   Aemeath-DMi Agent v2 - Setup
echo ============================================
echo.

echo [1/4] Checking Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Please install Node.js 20+ first: https://nodejs.org
    pause
    exit /b 1
)
echo [OK] Node.js found

echo [2/4] Checking Python...
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo Please install Python 3.10+ first: https://python.org
    pause
    exit /b 1
)
echo [OK] Python found

echo [3/4] Installing Node.js dependencies (monorepo workspaces)...
call npm install --cache .npm-cache
if %errorlevel% neq 0 (
    echo [FAIL] npm install failed
    pause
    exit /b 1
)
echo [OK] Node.js dependencies installed

echo [4/4] Installing Python dependencies (sympy/scipy/vision/control)...
pip install -r requirements.txt
if %errorlevel% neq 0 (
    pip3 install -r requirements.txt
)
echo [OK] Python dependencies installed

echo.
echo ============================================
echo  Setup Complete!
echo ============================================
echo.
echo  Next steps:
echo  1. Web UI (推荐): .\scripts\dsh.ps1 --profile aemeath --port 3081
echo     浏览器打开 http://127.0.0.1:3081 （默认角色：小爱同学）
echo  2. 桌面壳: cd app ^&^& npm install ^&^& npm start （托管 dsh 服务 + 品牌窗口）
echo  3. API Key: 在 Web 界面「设置 -^> API 密钥」填写，或写入 .dsh-home/.credentials.yaml
echo     （缺省回退环境变量 DEEPSEEK_API_KEY）
echo  4. 构建插件: npm run build （TS 源码 -^> packages/*/lib）
echo.
pause
