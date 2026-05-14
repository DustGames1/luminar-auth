@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo    Luminar Site - Deploy
echo ============================================
echo.

git status --short
echo.

git diff --quiet --cached
set CACHED=%errorlevel%
git diff --quiet
set UNCACHED=%errorlevel%
if %CACHED%==0 if %UNCACHED%==0 (
    echo No changes to deploy.
    pause
    exit /b 0
)

git add .
if errorlevel 1 (
    echo [ERROR] git add failed
    pause
    exit /b 1
)

set /p msg="Commit message (Enter for auto): "
if "%msg%"=="" (
    for /f "tokens=2 delims==" %%a in ('wmic OS Get localdatetime /value') do set ldt=%%a
    set msg=update !ldt:~0,4!-!ldt:~4,2!-!ldt:~6,2! !ldt:~8,2!:!ldt:~10,2!
)

setlocal enabledelayedexpansion
git commit -m "!msg!"
if errorlevel 1 (
    echo [ERROR] git commit failed
    endlocal
    pause
    exit /b 1
)

git push
if errorlevel 1 (
    echo [ERROR] git push failed
    endlocal
    pause
    exit /b 1
)
endlocal

echo.
echo ============================================
echo    Pushed. Vercel auto-deploy in ~30s
echo    https://luminar-five-drab.vercel.app
echo ============================================
pause
