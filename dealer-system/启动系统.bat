@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 经销商业绩查询系统

echo.
echo   正在启动 经销商业绩查询系统 ...
echo.

where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
  goto end
)

if exist "C:\Program Files\nodejs\node.exe" (
  "C:\Program Files\nodejs\node.exe" server.js
  goto end
)

if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\node.exe" (
  "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\node.exe" server.js
  goto end
)

echo   [错误] 未检测到 Node.js
echo   请先安装 Node.js 18 或更高版本： https://nodejs.org
echo.

:end
pause
