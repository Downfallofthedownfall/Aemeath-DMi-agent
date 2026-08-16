@echo off
chcp 65001 >nul
echo ============================================
echo   Aemeath-DMi Agent v2 - Setup
echo ============================================
echo.

echo [1/6] Checking Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Please install Node.js 22.13+ first: https://nodejs.org
    pause
    exit /b 1
)
echo [OK] Node.js found

echo [2/6] Checking Python...
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo Please install Python 3.10+ first: https://python.org
    pause
    exit /b 1
)
echo [OK] Python found

echo [3/6] Installing root npm dependencies (monorepo workspaces)...
call npm install --cache .npm-cache
if %errorlevel% neq 0 (
    echo [FAIL] npm install failed
    pause
    exit /b 1
)
echo [OK] Root dependencies installed

echo [4/6] Building plugins (TS -^> packages/*/lib)...
call npm run build
if %errorlevel% neq 0 (
    echo [FAIL] npm run build failed
    pause
    exit /b 1
)
echo [OK] Plugins built

echo [5/6] Installing profile dependencies (aemeath / aemeath-run, --legacy-peer-deps)...
cd profiles\aemeath
call npm install --legacy-peer-deps --cache ..\..\.npm-cache
set PROFILE_ERR=%errorlevel%
cd ..\..
if %PROFILE_ERR% neq 0 (
    echo [FAIL] aemeath profile install failed
    pause
    exit /b 1
)
cd profiles\aemeath-run
call npm install --legacy-peer-deps --cache ..\..\.npm-cache
set PROFILE_ERR=%errorlevel%
cd ..\..
if %PROFILE_ERR% neq 0 (
    echo [FAIL] aemeath-run profile install failed
    pause
    exit /b 1
)
echo [OK] Profile dependencies installed

echo [6/6] Installing Python dependencies (sympy/scipy/vision/control)...
python -m pip install -r requirements.txt
if errorlevel 1 pip install -r requirements.txt
if errorlevel 1 pip3 install -r requirements.txt
echo [OK] Python dependencies installed

echo.
echo ============================================
echo  Setup Complete!
echo ============================================
echo.
echo  Next steps:
echo  1. Web UI (推荐): .\scripts\dsh.ps1 --profile aemeath --port 3081
echo     浏览器打开 http://127.0.0.1:3081 （默认角色：爱弥斯）
echo  2. 桌面壳 (可选): cd app ^&^& npm install ^&^& npm start （托管 dsh 服务 + 品牌窗口）
echo  3. API Key: 在 Web 界面「设置 -^> API 密钥」填写，或写入 .dsh-home/.credentials.yaml
echo     （缺省回退环境变量 DEEPSEEK_API_KEY）
echo  4. 基准: python packages\benchmark\run_benchmark.py
echo  5. TTS (可选): 需 IndexTTS2 引擎 venv（默认 D:\index-tts\.venv\Scripts\python.exe，
echo     可用环境变量 AEMEATH_TTS_PYTHON 指定解释器）
echo.
pause
