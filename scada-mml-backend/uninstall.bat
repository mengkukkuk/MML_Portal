@echo off
REM ============================================================================
REM  MML Portal Backend - Windows Service Uninstaller
REM
REM  Stops and unregisters the service. Application files, .env, and the
REM  database are left untouched.
REM
REM  Self-elevates to Administrator automatically (UAC prompt).
REM  Just double-click this file.
REM
REM  Optional arguments:
REM     uninstall.bat [serviceName] [/removelogs] [/removevenv]
REM  Default serviceName: mml-api
REM     /removelogs   also delete the logs\ directory
REM     /removevenv   also delete the venv\ directory
REM ============================================================================

setlocal EnableExtensions EnableDelayedExpansion

REM -- Self-elevate ------------------------------------------------------------
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator elevation...
    if "%~1"=="" (
        powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    ) else (
        powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
    )
    exit /b
)

REM -- Run from the script's own directory -------------------------------------
cd /d "%~dp0"

REM -- Parameters --------------------------------------------------------------
set "SERVICE_NAME=mml-api"
set "REMOVE_LOGS="
set "REMOVE_VENV="
for %%a in (%*) do (
    if /i "%%~a"=="/removelogs" (
        set "REMOVE_LOGS=1"
    ) else if /i "%%~a"=="/removevenv" (
        set "REMOVE_VENV=1"
    ) else (
        set "SERVICE_NAME=%%~a"
    )
)

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

echo.
echo ============================================================
echo   MML Portal Backend - Service Uninstaller
echo   Service  : %SERVICE_NAME%
echo   Directory: %SCRIPT_DIR%
echo ============================================================

REM -- Locate NSSM -------------------------------------------------------------
set "NSSM_EXE="
if exist "%SCRIPT_DIR%\nssm.exe"        set "NSSM_EXE=%SCRIPT_DIR%\nssm.exe"
if not defined NSSM_EXE if exist "%SCRIPT_DIR%\tools\nssm.exe" set "NSSM_EXE=%SCRIPT_DIR%\tools\nssm.exe"
if not defined NSSM_EXE (
    for /f "delims=" %%n in ('where nssm 2^>nul') do (
        if not defined NSSM_EXE set "NSSM_EXE=%%n"
    )
)

REM -- Stop + remove service ---------------------------------------------------
echo.
echo ==^> Stopping and removing service: %SERVICE_NAME%
sc query "%SERVICE_NAME%" >nul 2>&1
if %errorlevel% neq 0 (
    echo     [!]  Service '%SERVICE_NAME%' not found - nothing to remove.
) else (
    if defined NSSM_EXE (
        "%NSSM_EXE%" stop "%SERVICE_NAME%" confirm >nul 2>&1
        timeout /t 2 /nobreak >nul
        "%NSSM_EXE%" remove "%SERVICE_NAME%" confirm
        echo     [OK] Service removed via NSSM.
    ) else (
        echo     [!]  NSSM not found; using sc.exe fallback.
        net stop "%SERVICE_NAME%" >nul 2>&1
        timeout /t 2 /nobreak >nul
        sc delete "%SERVICE_NAME%"
        echo     [OK] Service removed via sc.exe.
    )
)

REM -- Optional cleanup --------------------------------------------------------
if defined REMOVE_LOGS (
    echo.
    echo ==^> Removing logs directory
    if exist "%SCRIPT_DIR%\logs" (
        rmdir /s /q "%SCRIPT_DIR%\logs"
        echo     [OK] Removed: %SCRIPT_DIR%\logs
    ) else (
        echo     [!]  Logs directory not found: %SCRIPT_DIR%\logs
    )
)

if defined REMOVE_VENV (
    echo.
    echo ==^> Removing virtual environment
    if exist "%SCRIPT_DIR%\venv" (
        rmdir /s /q "%SCRIPT_DIR%\venv"
        echo     [OK] Removed: %SCRIPT_DIR%\venv
    ) else (
        echo     [!]  venv directory not found: %SCRIPT_DIR%\venv
    )
)

REM -- Summary -----------------------------------------------------------------
echo.
echo ============================================================
echo   Uninstall complete.
echo.
echo   Service '%SERVICE_NAME%' has been removed.
echo   Application files and .env were NOT touched.
echo.
echo   To reinstall: install.bat
echo ============================================================
echo.
pause
endlocal
exit /b 0
