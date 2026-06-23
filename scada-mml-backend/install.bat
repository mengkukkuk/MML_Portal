@echo off
REM ============================================================================
REM  MML Portal Backend - Windows Service Installer (NSSM)
REM
REM  Installs the FastAPI/uvicorn backend as a Windows service.
REM  - Creates a Python venv and installs dependencies
REM  - Guides .env setup if .env does not yet exist
REM  - Seeds the database (non-fatal if DB unreachable)
REM  - Registers and starts the service, then runs a health check
REM
REM  Self-elevates to Administrator automatically (UAC prompt).
REM  Just double-click this file.
REM
REM  Optional positional arguments:
REM     install.bat [bindHost] [port] [serviceName]
REM  Defaults: 127.0.0.1  8088  mml-api
REM     - bindHost 127.0.0.1 -> correct when fronted by IIS (production)
REM     - bindHost 0.0.0.0   -> standalone direct access, no reverse proxy
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
set "BIND_HOST=127.0.0.1"
set "PORT=8088"
set "SERVICE_NAME=mml-api"
if not "%~1"=="" set "BIND_HOST=%~1"
if not "%~2"=="" set "PORT=%~2"
if not "%~3"=="" set "SERVICE_NAME=%~3"

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "VENV_PYTHON=%SCRIPT_DIR%\venv\Scripts\python.exe"
set "LOG_DIR=%SCRIPT_DIR%\logs"
set "SERVICE_DISPLAY=MML Portal API"
set "SERVICE_DESC=MML Portal backend - FastAPI/uvicorn on port %PORT%"

echo.
echo ============================================================
echo   MML Portal Backend - Service Installer
echo   Service  : %SERVICE_NAME%
echo   Bind     : %BIND_HOST%:%PORT%
echo   Directory: %SCRIPT_DIR%
echo ============================================================

REM -- Step 1 - Python ---------------------------------------------------------
echo.
echo ==^> Checking Python
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [FATAL] Python not found in PATH. Install Python 3.10+ and retry.
    goto :fail
)
for /f "delims=" %%v in ('python --version 2^>^&1') do set "PYVER=%%v"
echo     [OK] !PYVER!

REM -- Step 2 - NSSM -----------------------------------------------------------
echo.
echo ==^> Locating NSSM
set "NSSM_EXE="
if exist "%SCRIPT_DIR%\nssm.exe"        set "NSSM_EXE=%SCRIPT_DIR%\nssm.exe"
if not defined NSSM_EXE if exist "%SCRIPT_DIR%\tools\nssm.exe" set "NSSM_EXE=%SCRIPT_DIR%\tools\nssm.exe"
if not defined NSSM_EXE (
    for /f "delims=" %%n in ('where nssm 2^>nul') do (
        if not defined NSSM_EXE set "NSSM_EXE=%%n"
    )
)
if not defined NSSM_EXE (
    echo.
    echo [FATAL] NSSM not found.
    echo   Place nssm.exe in the project folder: %SCRIPT_DIR%\nssm.exe
    echo   OR install NSSM and add it to PATH.
    echo   Download: https://nssm.cc/download
    goto :fail
)
echo     [OK] NSSM: !NSSM_EXE!

REM -- Step 3 - Virtual environment --------------------------------------------
echo.
echo ==^> Setting up Python virtual environment
if not exist "%VENV_PYTHON%" (
    echo     Creating venv ^(this may take a moment^)...
    python -m venv "%SCRIPT_DIR%\venv"
    if !errorlevel! neq 0 (
        echo [FATAL] Failed to create Python virtual environment.
        goto :fail
    )
)
echo     [OK] venv: %SCRIPT_DIR%\venv

REM -- Step 4 - Dependencies ---------------------------------------------------
echo.
echo ==^> Installing Python dependencies
"%VENV_PYTHON%" -m pip install --upgrade pip -q
"%VENV_PYTHON%" -m pip install -r "%SCRIPT_DIR%\requirements.txt" -q
if %errorlevel% neq 0 (
    echo [FATAL] pip install failed. Check your network connection.
    goto :fail
)
echo     [OK] Dependencies installed.

REM -- Step 5 - .env -----------------------------------------------------------
echo.
echo ==^> Configuring .env
set "ENV_FILE=%SCRIPT_DIR%\.env"
set "ENV_EXAMPLE=%SCRIPT_DIR%\.env.example"
if exist "%ENV_FILE%" (
    echo     [OK] .env already exists - skipping interactive setup. Edit manually if needed:
    echo     [OK]   %ENV_FILE%
) else (
    if not exist "%ENV_EXAMPLE%" (
        echo [FATAL] .env.example not found in %SCRIPT_DIR% - cannot create .env.
        goto :fail
    )
    copy /y "%ENV_EXAMPLE%" "%ENV_FILE%" >nul
    echo.
    echo     .env copied from .env.example.
    echo     Provide the required values below ^(Enter = keep existing default^).
    echo.
    set /p "DBPASS=    DB_PASSWORD (Postgres password): "
    set /p "JWTIN=    JWT_SECRET  (Enter to auto-generate a secure random key): "
    if not defined JWTIN (
        for /f "delims=" %%j in ('"%VENV_PYTHON%" -c "import secrets;print(secrets.token_hex(32))"') do set "JWTIN=%%j"
        echo     [!]  Generated JWT_SECRET: !JWTIN!
    )
    set /p "CORSIN=    CORS_ORIGINS [http://localhost:5173] (comma-separated frontend URL(s)): "
    if not defined CORSIN set "CORSIN=http://localhost:5173"

    "%VENV_PYTHON%" -c "import os,re;p=r'%ENV_FILE%';s=open(p,encoding='utf-8').read();s=re.sub(r'(?m)^DB_PASSWORD=.*$','DB_PASSWORD='+os.environ.get('DBPASS',''),s);s=re.sub(r'(?m)^JWT_SECRET=.*$','JWT_SECRET='+os.environ.get('JWTIN',''),s);s=(re.sub(r'(?m)^CORS_ORIGINS=.*$','CORS_ORIGINS='+os.environ.get('CORSIN',''),s) if re.search(r'(?m)^CORS_ORIGINS=',s) else s.rstrip()+'\nCORS_ORIGINS='+os.environ.get('CORSIN','')+'\n');open(p,'w',encoding='utf-8').write(s)"
    if !errorlevel! neq 0 (
        echo [FATAL] Failed to write .env values.
        goto :fail
    )
    echo     [OK] .env created at %ENV_FILE%
)

REM -- Step 6 - Logs directory -------------------------------------------------
echo.
echo ==^> Creating logs directory
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
echo     [OK] Logs: %LOG_DIR%

REM -- Step 7 - Database seed (optional, non-fatal) ----------------------------
echo.
echo ==^> Seeding database (creates schema + mock users if reachable)
if exist "%SCRIPT_DIR%\seed_users.py" (
    "%VENV_PYTHON%" "%SCRIPT_DIR%\seed_users.py"
    if !errorlevel! equ 0 (
        echo     [OK] Database seeded.
    ) else (
        echo     [!]  Seed returned non-zero exit code. DB may not be reachable yet.
        echo     [!]  Run manually once DB is up: "%VENV_PYTHON%" seed_users.py
    )
) else (
    echo     [!]  seed_users.py not found - skipping schema/seed step.
)

REM -- Step 8 - Remove existing service if present -----------------------------
echo.
echo ==^> Registering Windows service: %SERVICE_NAME%
sc query "%SERVICE_NAME%" >nul 2>&1
if %errorlevel% equ 0 (
    echo     [!]  Service '%SERVICE_NAME%' already exists. Stopping and removing...
    "%NSSM_EXE%" stop "%SERVICE_NAME%" confirm >nul 2>&1
    "%NSSM_EXE%" remove "%SERVICE_NAME%" confirm >nul 2>&1
    timeout /t 2 /nobreak >nul
)

REM -- Step 9 - Install + configure via NSSM -----------------------------------
"%NSSM_EXE%" install "%SERVICE_NAME%" "%VENV_PYTHON%" -m uvicorn main:app --host %BIND_HOST% --port %PORT%
"%NSSM_EXE%" set "%SERVICE_NAME%" AppDirectory        "%SCRIPT_DIR%"
"%NSSM_EXE%" set "%SERVICE_NAME%" DisplayName         "%SERVICE_DISPLAY%"
"%NSSM_EXE%" set "%SERVICE_NAME%" Description         "%SERVICE_DESC%"
"%NSSM_EXE%" set "%SERVICE_NAME%" Start               SERVICE_AUTO_START
"%NSSM_EXE%" set "%SERVICE_NAME%" AppStdout           "%LOG_DIR%\stdout.log"
"%NSSM_EXE%" set "%SERVICE_NAME%" AppStderr           "%LOG_DIR%\stderr.log"
"%NSSM_EXE%" set "%SERVICE_NAME%" AppRotateFiles      1
"%NSSM_EXE%" set "%SERVICE_NAME%" AppRotateSeconds    86400
"%NSSM_EXE%" set "%SERVICE_NAME%" AppEnvironmentExtra PYTHONUNBUFFERED=1
echo     [OK] Service registered.

REM -- Step 10 - Start service -------------------------------------------------
echo.
echo ==^> Starting service
"%NSSM_EXE%" start "%SERVICE_NAME%" >nul 2>&1
timeout /t 4 /nobreak >nul
sc query "%SERVICE_NAME%" | find "RUNNING" >nul
if %errorlevel% equ 0 (
    echo     [OK] Service is running.
) else (
    echo     [!]  Service is not running yet. Check logs for startup errors:
    echo     [!]    %LOG_DIR%\stderr.log
)

REM -- Step 11 - Health check --------------------------------------------------
echo.
echo ==^> Health check - http://127.0.0.1:%PORT%/health
timeout /t 2 /nobreak >nul
where curl >nul 2>&1
if %errorlevel% equ 0 (
    curl -s -m 10 "http://127.0.0.1:%PORT%/health"
    echo.
) else (
    powershell -NoProfile -Command "try { (Invoke-RestMethod -Uri 'http://127.0.0.1:%PORT%/health' -TimeoutSec 10 | ConvertTo-Json -Compress) } catch { Write-Host '[!] Health check failed (service may still be starting):' $_.Exception.Message }"
)

REM -- Summary -----------------------------------------------------------------
echo.
echo ============================================================
echo   Installation complete!
echo.
echo   Service  : %SERVICE_NAME%  (%BIND_HOST%:%PORT%)
echo   Logs     : %LOG_DIR%
echo.
echo   Management (run as Administrator):
echo     Start    : nssm start %SERVICE_NAME%      (or: sc start %SERVICE_NAME%)
echo     Stop     : nssm stop %SERVICE_NAME%       (or: sc stop %SERVICE_NAME%)
echo     Restart  : nssm restart %SERVICE_NAME%
echo     Status   : sc query %SERVICE_NAME%
echo     Logs     : %LOG_DIR%\stdout.log  /  stderr.log
echo.
echo   Edit config : %ENV_FILE%
echo   After editing .env, run: nssm restart %SERVICE_NAME%
echo ============================================================
echo.
pause
endlocal
exit /b 0

:fail
echo.
echo Installation aborted.
echo.
pause
endlocal
exit /b 1