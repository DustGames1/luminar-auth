@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo    Luminar Site - Auto Deploy
echo ============================================

git diff --quiet --cached
set CACHED=%errorlevel%
git diff --quiet
set UNCACHED=%errorlevel%
if %CACHED%==0 if %UNCACHED%==0 (
    echo No changes to deploy.
    exit /b 0
)

for /f "tokens=2 delims==" %%a in ('wmic OS Get localdatetime /value') do set ldt=%%a
setlocal enabledelayedexpansion
set msg=auto !ldt:~0,4!-!ldt:~4,2!-!ldt:~6,2! !ldt:~8,2!:!ldt:~10,2!:!ldt:~12,2!

git add .
git commit -m "!msg!"
if errorlevel 1 (
    echo [ERROR] commit failed
    endlocal
    exit /b 1
)

git push
if errorlevel 1 (
    echo [ERROR] push failed
    endlocal
    exit /b 1
)
endlocal

echo.
echo Pushed. Vercel deploys in ~30s
echo https://luminar-five-drab.vercel.app
