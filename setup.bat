@echo off
chcp 65001 >nul
echo ============================================
echo   Aemeath-DMi Agent v2 - Setup
echo ============================================
echo.

echo [1/7] Checking Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Please install Node.js 22.13+ first: https://nodejs.org
    pause
    exit /b 1
)
echo [OK] Node.js found

echo [2/7] Checking Python...
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo Please install Python 3.10+ first: https://python.org
    pause
    exit /b 1
)
echo [OK] Python found

echo [3/7] Installing root npm dependencies (monorepo workspaces)...
call npm install --cache .npm-cache
if %errorlevel% neq 0 (
    echo [FAIL] npm install failed
    pause
    exit /b 1
)
echo [OK] Root dependencies installed

echo [4/7] Building plugins (TS -^> packages/*/lib)...
call npm run build
if %errorlevel% neq 0 (
    echo [FAIL] npm run build failed
    pause
    exit /b 1
)
echo [OK] Plugins built

echo [5/7] Installing profile dependencies (aemeath / aemeath-run, --legacy-peer-deps)...
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

echo [6/7] Installing Python dependencies (sympy/scipy/vision/control)...
python -m pip install -r requirements.txt
if errorlevel 1 pip install -r requirements.txt
if errorlevel 1 pip3 install -r requirements.txt
echo [OK] Python dependencies installed

echo [7/7] Installing Electron shell dependencies (app/, first run downloads Electron ~100MB)...
cd app
call npm install --cache ..\.npm-cache
set APP_ERR=%errorlevel%
cd ..
if %APP_ERR% neq 0 (
    echo [FAIL] app (Electron shell) install failed
    pause
    exit /b 1
)
echo [OK] Electron shell dependencies installed

echo [8/8] Enabling German locale (patch dsh client-locale, idempotent)...
powershell -ExecutionPolicy Bypass -File scripts\patch-de-locale.ps1
if %errorlevel% neq 0 (
    echo [WARN] patch-de-locale failed (German UI unavailable; English/Chinese still work)
) else (
    echo [OK] German locale enabled
)

echo.
echo ============================================
echo  Setup Complete!
echo ============================================
echo.
echo  Next steps:
echo  1. 桌宠（推荐）: cd app ^&^& npm start
echo     自动托管 dsh 服务 + 打开品牌窗口（爱弥斯 · 物理学习 Copilot）
echo  2. Web UI: .\scripts\dsh.ps1 --profile aemeath --port 3081
echo     浏览器打开 http://127.0.0.1:3081 （默认角色：爱弥斯）
echo  3. API Key: 在 Web 界面「设置 -^> API 密钥」填写，或写入 .dsh-home/.credentials.yaml
echo     （缺省回退环境变量 DEEPSEEK_API_KEY）
echo  4. 语言: Web 界面「设置 -^> 语言」可选 中文 / English / Deutsch（npm install 后需重跑
echo     scripts\patch-de-locale.ps1 启用德文；英文/中文无需）
echo  5. 基准: python packages\benchmark\run_benchmark.py
echo  6. TTS (可选): 需 IndexTTS2 引擎 venv（默认 D:\index-tts\.venv\Scripts\python.exe，
echo     可用环境变量 AEMEATH_TTS_PYTHON 指定解释器）
echo.
pause
