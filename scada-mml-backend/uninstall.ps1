<#
.SYNOPSIS
    Removes the MML Portal backend Windows service.

.DESCRIPTION
    Stops and unregisters the service. Application files, .env, and database
    are left untouched. Use -RemoveLogs or -RemoveVenv to also clean those up.
    Requires administrator elevation (self-elevates automatically).

.PARAMETER ServiceName
    Windows service name to remove. Default: mml-api.

.PARAMETER RemoveLogs
    Also delete the logs\ directory inside the project folder.

.PARAMETER RemoveVenv
    Also delete the venv\ directory inside the project folder.

.EXAMPLE
    # Remove service only
    .\uninstall.ps1

.EXAMPLE
    # Remove service, logs, and venv
    .\uninstall.ps1 -RemoveLogs -RemoveVenv
#>

[CmdletBinding()]
param(
    [string]$ServiceName = "mml-api",
    [switch]$RemoveLogs,
    [switch]$RemoveVenv
)

$ErrorActionPreference = "Continue"
$SCRIPT_DIR = $PSScriptRoot

# -- Helpers ------------------------------------------------------------------
function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK([string]$msg)   { Write-Host "    [OK] $msg"  -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "    [!]  $msg"  -ForegroundColor Yellow }

# -- Self-elevate -------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
               [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "Requesting administrator elevation..." -ForegroundColor Yellow
    $relaunchArgs = @("-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-ServiceName", $ServiceName)
    if ($RemoveLogs) { $relaunchArgs += "-RemoveLogs" }
    if ($RemoveVenv) { $relaunchArgs += "-RemoveVenv" }
    $proc = Start-Process powershell -Verb RunAs -ArgumentList $relaunchArgs -Wait -PassThru
    exit $proc.ExitCode
}

# -- Banner -------------------------------------------------------------------
Write-Host ""
Write-Host "============================================================" -ForegroundColor Magenta
Write-Host "  MML Portal Backend - Service Uninstaller"                  -ForegroundColor Magenta
Write-Host "  Service  : $ServiceName"                                   -ForegroundColor Magenta
Write-Host "  Directory: $SCRIPT_DIR"                                    -ForegroundColor Magenta
Write-Host "============================================================" -ForegroundColor Magenta

# -- Find NSSM ----------------------------------------------------------------
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

# -- Stop + remove service ----------------------------------------------------
Write-Step "Stopping and removing service: $ServiceName"
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Warn "Service '$ServiceName' not found - nothing to remove."
} else {
    if ($nssmExe) {
        & $nssmExe stop $ServiceName confirm 2>$null
        Start-Sleep -Seconds 2
        & $nssmExe remove $ServiceName confirm
        Write-OK "Service removed via NSSM."
    } else {
        # NSSM not available - fall back to sc.exe
        Write-Warn "NSSM not found; using sc.exe fallback."
        Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        & sc.exe delete $ServiceName
        Write-OK "Service removed via sc.exe."
    }
}

# -- Optional cleanup ---------------------------------------------------------
if ($RemoveLogs) {
    Write-Step "Removing logs directory"
    $logDir = Join-Path $SCRIPT_DIR "logs"
    if (Test-Path $logDir) {
        Remove-Item $logDir -Recurse -Force
        Write-OK "Removed: $logDir"
    } else {
        Write-Warn "Logs directory not found: $logDir"
    }
}

if ($RemoveVenv) {
    Write-Step "Removing virtual environment"
    $venvDir = Join-Path $SCRIPT_DIR "venv"
    if (Test-Path $venvDir) {
        Remove-Item $venvDir -Recurse -Force
        Write-OK "Removed: $venvDir"
    } else {
        Write-Warn "venv directory not found: $venvDir"
    }
}

# -- Summary ------------------------------------------------------------------
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Uninstall complete." -ForegroundColor Green
Write-Host "" -ForegroundColor Green
Write-Host "  Service '$ServiceName' has been removed." -ForegroundColor Green
Write-Host "  Application files and .env were NOT touched." -ForegroundColor Green
Write-Host "" -ForegroundColor Green
Write-Host "  To reinstall: .\install.ps1" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green

Read-Host "`nPress Enter to exit"
