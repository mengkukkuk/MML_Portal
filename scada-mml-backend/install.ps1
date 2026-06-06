<#
.SYNOPSIS
    Installs the MML Portal backend as a Windows service via NSSM.

.DESCRIPTION
    - Creates a Python virtual environment and installs dependencies.
    - Guides you through .env configuration if .env does not yet exist.
    - Optionally seeds the database with the schema and mock users.
    - Registers and starts the Windows service.
    Requires administrator elevation (self-elevates automatically).

.PARAMETER BindHost
    Host that uvicorn binds to.
    Default: 127.0.0.1 - correct when fronted by IIS (recommended for production).
    Use 0.0.0.0 for standalone direct access without a reverse proxy.

.PARAMETER Port
    TCP port uvicorn listens on. Default: 8088.

.PARAMETER ServiceName
    Name of the Windows service. Default: mml-api.

.EXAMPLE
    # Behind IIS (default)
    .\install.ps1

.EXAMPLE
    # Standalone, no IIS, expose directly
    .\install.ps1 -BindHost 0.0.0.0

.EXAMPLE
    # Custom port and service name
    .\install.ps1 -Port 9000 -ServiceName mml-api
#>

[CmdletBinding()]
param(
    [string]$BindHost    = "127.0.0.1",
    [int]   $Port        = 8088,
    [string]$ServiceName = "mml-api"
)

$ErrorActionPreference = "Stop"

# -- Constants ----------------------------------------------------------------
$SERVICE_DISPLAY = "MML Portal API"
$SERVICE_DESC    = "MML Portal backend - FastAPI/uvicorn on port $Port"
$SCRIPT_DIR      = $PSScriptRoot
$VENV_PYTHON     = Join-Path $SCRIPT_DIR "venv\Scripts\python.exe"
$LOG_DIR         = Join-Path $SCRIPT_DIR "logs"

# -- Helpers ------------------------------------------------------------------
function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK([string]$msg)   { Write-Host "    [OK] $msg"  -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "    [!]  $msg"  -ForegroundColor Yellow }
function Abort([string]$msg) {
    Write-Host "`n[FATAL] $msg" -ForegroundColor Red
    Read-Host "`nPress Enter to exit"
    exit 1
}

# -- Self-elevate -------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
               [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "Requesting administrator elevation..." -ForegroundColor Yellow
    $relaunchArgs = @("-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    foreach ($kv in $PSBoundParameters.GetEnumerator()) {
        $relaunchArgs += "-$($kv.Key)"
        if ($kv.Value -isnot [switch]) { $relaunchArgs += "$($kv.Value)" }
    }
    $proc = Start-Process powershell -Verb RunAs -ArgumentList $relaunchArgs -Wait -PassThru
    exit $proc.ExitCode
}

# -- Banner -------------------------------------------------------------------
Write-Host ""
Write-Host "============================================================" -ForegroundColor Magenta
Write-Host "  MML Portal Backend - Service Installer"                    -ForegroundColor Magenta
Write-Host "  Service  : $ServiceName"                                   -ForegroundColor Magenta
Write-Host "  Bind     : ${BindHost}:${Port}"                            -ForegroundColor Magenta
Write-Host "  Directory: $SCRIPT_DIR"                                    -ForegroundColor Magenta
Write-Host "============================================================" -ForegroundColor Magenta

# -- Step 1 - Python ----------------------------------------------------------
Write-Step "Checking Python"
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCmd) {
    Abort "Python not found in PATH. Install Python 3.10+ and retry."
}
$pyVer = & python --version 2>&1
Write-OK "$pyVer"

# -- Step 2 - NSSM ------------------------------------------------------------
Write-Step "Locating NSSM"
$nssmExe = $null
foreach ($candidate in @(
    (Join-Path $SCRIPT_DIR "nssm.exe"),
    (Join-Path $SCRIPT_DIR "tools\nssm.exe")
)) {
    if (Test-Path $candidate) { $nssmExe = $candidate; break }
}
if (-not $nssmExe) {
    $found = Get-Command nssm -ErrorAction SilentlyContinue
    if ($found) { $nssmExe = $found.Source }
}
if (-not $nssmExe) {
    Write-Host ""
    Write-Host "[FATAL] NSSM not found." -ForegroundColor Red
    Write-Host "  Place nssm.exe in the project folder: $SCRIPT_DIR\nssm.exe" -ForegroundColor Red
    Write-Host "  OR install NSSM and add it to PATH." -ForegroundColor Red
    Write-Host "  Download: https://nssm.cc/download" -ForegroundColor Yellow
    Read-Host "`nPress Enter to exit"
    exit 1
}
Write-OK "NSSM: $nssmExe"

# -- Step 3 - Virtual environment ---------------------------------------------
Write-Step "Setting up Python virtual environment"
if (-not (Test-Path $VENV_PYTHON)) {
    Write-Host "    Creating venv (this may take a moment)..." -ForegroundColor Yellow
    & python -m venv (Join-Path $SCRIPT_DIR "venv")
    if ($LASTEXITCODE -ne 0) { Abort "Failed to create Python virtual environment." }
}
Write-OK "venv: $(Join-Path $SCRIPT_DIR 'venv')"

# -- Step 4 - Dependencies ----------------------------------------------------
Write-Step "Installing Python dependencies"
& $VENV_PYTHON -m pip install --upgrade pip -q
& $VENV_PYTHON -m pip install -r (Join-Path $SCRIPT_DIR "requirements.txt") -q
if ($LASTEXITCODE -ne 0) { Abort "pip install failed. Check your network connection." }
Write-OK "Dependencies installed."

# -- Step 5 - .env ------------------------------------------------------------
Write-Step "Configuring .env"
$envFile    = Join-Path $SCRIPT_DIR ".env"
$envExample = Join-Path $SCRIPT_DIR ".env.example"

if (-not (Test-Path $envFile)) {
    if (-not (Test-Path $envExample)) {
        Abort ".env.example not found in $SCRIPT_DIR - cannot create .env."
    }
    Copy-Item $envExample $envFile

    Write-Host ""
    Write-Host "    .env copied from .env.example." -ForegroundColor Yellow
    Write-Host "    Provide the required values below (Enter = keep existing default)." -ForegroundColor Yellow
    Write-Host ""

    # DB_PASSWORD (required - no default in .env.example)
    $dbPass = Read-Host "    DB_PASSWORD (Postgres password)"

    # JWT_SECRET - auto-generate if blank
    $jwtInput = Read-Host "    JWT_SECRET  (Enter to auto-generate a secure random key)"
    if (-not $jwtInput) {
        $jwtInput = & $VENV_PYTHON -c "import secrets; print(secrets.token_hex(32))"
        Write-Warn "Generated JWT_SECRET: $jwtInput"
    }

    # CORS origins - needed in .env even though main.py has a fallback default
    $corsInput = Read-Host "    CORS_ORIGINS [http://localhost:5173] (comma-separated frontend URL(s))"
    if (-not $corsInput) { $corsInput = "http://localhost:5173" }

    # Patch the copied .env in-place
    $content = Get-Content $envFile -Raw
    $content = [regex]::Replace($content, '(?m)^DB_PASSWORD=.*$', "DB_PASSWORD=$dbPass")
    $content = [regex]::Replace($content, '(?m)^JWT_SECRET=.*$',  "JWT_SECRET=$jwtInput")
    if ($content -match '(?m)^CORS_ORIGINS=') {
        $content = [regex]::Replace($content, '(?m)^CORS_ORIGINS=.*$', "CORS_ORIGINS=$corsInput")
    } else {
        $content = $content.TrimEnd() + "`nCORS_ORIGINS=$corsInput`n"
    }
    $content | Out-File $envFile -Encoding utf8 -NoNewline
    Write-OK ".env created at $envFile"
} else {
    Write-OK ".env already exists - skipping interactive setup. Edit manually if needed:"
    Write-OK "  $envFile"
}

# -- Step 6 - Logs directory --------------------------------------------------
Write-Step "Creating logs directory"
New-Item -ItemType Directory -Force $LOG_DIR | Out-Null
Write-OK "Logs: $LOG_DIR"

# -- Step 7 - Database seed (optional, non-fatal) -----------------------------
Write-Step "Seeding database (creates schema + mock users if reachable)"
$seedScript = Join-Path $SCRIPT_DIR "seed_users.py"
if (Test-Path $seedScript) {
    $ErrorActionPreference = "Continue"
    $seedOut = & $VENV_PYTHON $seedScript 2>&1
    $ErrorActionPreference = "Stop"
    if ($LASTEXITCODE -eq 0) {
        Write-OK ($seedOut -join " | ")
    } else {
        Write-Warn "Seed returned non-zero exit code. DB may not be reachable yet."
        Write-Warn "Run manually once DB is up: $VENV_PYTHON seed_users.py"
    }
} else {
    Write-Warn "seed_users.py not found - skipping schema/seed step."
}

# -- Step 8 - Remove existing service if present ------------------------------
Write-Step "Registering Windows service: $ServiceName"
$existingSvc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingSvc) {
    Write-Warn "Service '$ServiceName' already exists. Stopping and removing..."
    & $nssmExe stop $ServiceName confirm 2>$null
    Start-Sleep -Seconds 2
    & $nssmExe remove $ServiceName confirm
    Start-Sleep -Seconds 1
}

# -- Step 9 - Install + configure via NSSM ------------------------------------
$uvicornArgs = "-m uvicorn main:app --host $BindHost --port $Port"
& $nssmExe install $ServiceName $VENV_PYTHON $uvicornArgs
& $nssmExe set $ServiceName AppDirectory        $SCRIPT_DIR
& $nssmExe set $ServiceName DisplayName         $SERVICE_DISPLAY
& $nssmExe set $ServiceName Description         $SERVICE_DESC
& $nssmExe set $ServiceName Start               SERVICE_AUTO_START
& $nssmExe set $ServiceName AppStdout           (Join-Path $LOG_DIR "stdout.log")
& $nssmExe set $ServiceName AppStderr           (Join-Path $LOG_DIR "stderr.log")
& $nssmExe set $ServiceName AppRotateFiles      1
& $nssmExe set $ServiceName AppRotateSeconds    86400
& $nssmExe set $ServiceName AppEnvironmentExtra "PYTHONUNBUFFERED=1"
Write-OK "Service registered."

# -- Step 10 - Start service --------------------------------------------------
Write-Step "Starting service"
Start-Service $ServiceName
Start-Sleep -Seconds 4

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-OK "Service is running."
} else {
    Write-Warn "Service status: $($svc.Status). Check logs for startup errors:"
    Write-Warn "  $(Join-Path $LOG_DIR 'stderr.log')"
}

# -- Step 11 - Health check ---------------------------------------------------
Write-Step "Health check - http://127.0.0.1:${Port}/health"
Start-Sleep -Seconds 2
$ErrorActionPreference = "Continue"
try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Method GET -TimeoutSec 10
    if ($resp.status -eq "ok") {
        Write-OK "PASS - $($resp | ConvertTo-Json -Compress)"
    } else {
        Write-Warn "Unexpected response: $($resp | ConvertTo-Json -Compress)"
    }
} catch {
    Write-Warn "Health check failed (service may still be starting): $($_.Exception.Message)"
    Write-Warn "Retry later: Invoke-RestMethod http://127.0.0.1:$Port/health"
}
$ErrorActionPreference = "Stop"

# -- Summary ------------------------------------------------------------------
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host "" -ForegroundColor Green
Write-Host "  Service  : $ServiceName  (${BindHost}:${Port})" -ForegroundColor Green
Write-Host "  Logs     : $LOG_DIR" -ForegroundColor Green
Write-Host "" -ForegroundColor Green
Write-Host "  Management (run as Administrator):" -ForegroundColor Green
Write-Host "    Start    : Start-Service $ServiceName" -ForegroundColor Green
Write-Host "    Stop     : Stop-Service $ServiceName" -ForegroundColor Green
Write-Host "    Restart  : Restart-Service $ServiceName" -ForegroundColor Green
Write-Host "    Status   : Get-Service $ServiceName" -ForegroundColor Green
Write-Host "    Stdout   : Get-Content '$(Join-Path $LOG_DIR 'stdout.log')' -Tail 50 -Wait" -ForegroundColor Green
Write-Host "    Stderr   : Get-Content '$(Join-Path $LOG_DIR 'stderr.log')' -Tail 50 -Wait" -ForegroundColor Green
Write-Host "" -ForegroundColor Green
Write-Host "  Edit config : $envFile" -ForegroundColor Green
Write-Host "  After editing .env, run: Restart-Service $ServiceName" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green

Read-Host "`nPress Enter to exit"
