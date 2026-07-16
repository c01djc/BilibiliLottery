@echo off
chcp 65001 >nul
cd /d "%~dp0"

setlocal enabledelayedexpansion
set PORT=3000
set FOUND=0

echo.
echo 正在停止 Bilibili 粉丝抽奖工具...
echo.

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
    set FOUND=1
)

if !FOUND! equ 1 (
    echo [已停止] 服务已关闭
    echo http://localhost:%PORT% 将无法访问
) else (
    echo [提示] 未检测到运行中的服务
)

echo.
timeout /t 3 >nul
endlocal
