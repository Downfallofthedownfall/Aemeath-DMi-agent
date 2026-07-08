@echo off
echo ===== 爱弥斯桌面助手 - 一键部署 =====
echo.

echo [1/6] 检查 Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo 请先安装 Node.js: https://nodejs.org
    pause
    exit
)

echo [2/6] 检查 Docker...
where docker >nul 2>nul
if %errorlevel% neq 0 (
    echo 请先安装 Docker Desktop: https://docker.com
    pause
    exit
)

echo [3/6] 检查 Python...
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo 请安装 Python 3.10+
    pause
    exit
)

echo [4/6] 安装 Python 依赖...
pip install -r requirements.txt

echo [5/6] 安装 Electron 依赖...
cd electron-app
npm install
cd ..

echo [6/6] 启动 Dify 并恢复配置...
cd dify/docker
docker compose up -d

:: 等待 Dify 就绪
echo 等待 Dify 就绪...
:waitloop
timeout /t 3 /nobreak >nul
curl -s http://localhost/health >nul 2>nul
if %errorlevel% neq 0 goto waitloop

:: ===== 首次运行配置 =====
if not exist ..\..\electron-app\config.json (
    cd ..\..
    echo.
    echo ===== 首次运行需要配置两个 API Key =====
    echo.
    
    :: DeepSeek API Key
    echo [1/2] 请输入你的 DeepSeek API Key：
    echo （获取地址: https://platform.deepseek.com/api_keys）
    set /p DEEPSEEK_KEY=
    
    :: 通义千问 API Key（用于知识库检索重排序）
    echo.
    echo [2/2] 请输入你的通义千问 API Key：
    echo （获取地址: https://help.aliyun.com/zh/model-studio/getting-started/first-api-call-to-qwen）
    set /p QWEN_KEY=
    
    :: 写入 config.json
    echo { > electron-app\config.json
    echo   "dify_api_base": "http://localhost/v1", >> electron-app\config.json
    echo   "deepseek_api_key": "%DEEPSEEK_KEY%", >> electron-app\config.json
    echo   "qwen_api_key": "%QWEN_KEY%", >> electron-app\config.json
    echo   "modes": { >> electron-app\config.json
    echo     "aemeath": { >> electron-app\config.json
    echo       "name": "爱弥斯桌宠", >> electron-app\config.json
    echo       "dify_api_key": "%DEEPSEEK_KEY%" >> electron-app\config.json
    echo     }, >> electron-app\config.json
    echo     "physicist": { >> electron-app\config.json
    echo       "name": "星炬物理学霸", >> electron-app\config.json
    echo       "dify_api_key": "%DEEPSEEK_KEY%" >> electron-app\config.json
    echo     } >> electron-app\config.json
    echo   }, >> electron-app\config.json
    echo   "ooc_workflow_key": "%DEEPSEEK_KEY%" >> electron-app\config.json
    echo } >> electron-app\config.json
    
    :: 通过 Dify API 配置模型 Key
    echo 正在配置模型...
    curl -X POST http://localhost/api/models/default ^
        -H "Content-Type: application/json" ^
        -d "{\"model\":\"deepseek-chat\",\"credentials\":{\"api_key\":\"%DEEPSEEK_KEY%\"}}"
    
    curl -X POST http://localhost/api/models/rerank ^
        -H "Content-Type: application/json" ^
        -d "{\"model\":\"qwen3-rerank\",\"credentials\":{\"api_key\":\"%QWEN_KEY%\"}}"
    
    echo API Key 配置完成！
) else (
    echo config.json 已存在，跳过配置。
)

cd ..\..
echo.
echo ===== 部署完成！ =====
echo 启动爱弥斯: cd electron-app ^&^& npm start
echo.
pause
