@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ============================================
echo   Bilibili 粉丝抽奖工具  作者 Leetaohua
echo ============================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装：
    echo        https://nodejs.org
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo [提示] 首次运行，正在安装依赖，请稍候...
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
    echo.
)

set PORT=3000
set URL=http://localhost:%PORT%

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
    echo [重启] 检测到旧服务，正在停止 PID %%a ...
    taskkill /PID %%a /F >nul 2>&1
    timeout /t 1 >nul
)

echo [启动] 正在后台启动服务...
cscript //nologo "%~dp0start-server.vbs"
timeout /t 2 >nul

netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 服务启动失败，请查看 server.log
    pause
    exit /b 1
)

echo.
echo --------------------------------------------
echo   访问地址: %URL%
echo.
echo   服务已在后台运行，可关闭本窗口
echo   停止服务请双击 停止.bat
echo --------------------------------------------
echo.

start "" %URL%
timeout /t 4 >nul
exit /b 0
