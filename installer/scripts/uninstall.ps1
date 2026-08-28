<#
.SYNOPSIS
    Uninstall hook for the MMLPortal offline installer. Invoked elevated from
    MMLPortal.iss's [UninstallRun].

.DESCRIPTION
    Stops/removes the mml-api NSSM service and the MMLPortal IIS site + app pool.
    Deliberately leaves PostgreSQL, .env, and logs\ in place  -  mirrors the same caution as
    scada-mml-backend\uninstall.ps1 (data safety over a "clean" uninstall).

.PARAMETER InstallDir
    Root install directory (Inno's {app}), used to locate nssm.exe.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$InstallDir,
    [string]$ServiceName = "mml-api",
    [string]$SiteName = "MMLPortal",
    [string]$AppPoolName = "MMLPortalPool"
)

$ErrorActionPreference = "Continue"

$LogDir  = "C:\ProgramData\MMLPortal"
$LogFile = Join-Path $LogDir "uninstall.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
function Write-Log([string]$msg) {
    $line = "{0}  {1}" -f (Get-Date -Format "s"), $msg
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

Write-Log "===== MMLPortal uninstall starting ====="

# -- NSSM service ---------------------------------------------------------------
$nssmExe = Join-Path $InstallDir "tools\nssm.exe"
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    if (Test-Path $nssmExe) {
        & $nssmExe stop $ServiceName confirm 2>$null
        Start-Sleep -Seconds 2
        & $nssmExe remove $ServiceName confirm
        Write-Log "Removed service $ServiceName via nssm.exe"
    } else {
        Stop-Service $ServiceName -ErrorAction SilentlyContinue
        sc.exe delete $ServiceName | Out-Null
        Write-Log "Removed service $ServiceName via sc.exe (nssm.exe not found at $nssmExe)"
    }
} else {
    Write-Log "Service $ServiceName not present, skipping."
}

# -- IIS site + app pool ---------------------------------------------------------
try {
    Import-Module WebAdministration -ErrorAction Stop
    if (Get-Website -Name $SiteName -ErrorAction SilentlyContinue) {
        Remove-Website -Name $SiteName
        Write-Log "Removed IIS site $SiteName"
    } else {
        Write-Log "IIS site $SiteName not present, skipping."
    }
    if (Get-WebAppPoolState -Name $AppPoolName -ErrorAction SilentlyContinue) {
        Remove-WebAppPool -Name $AppPoolName
        Write-Log "Removed app pool $AppPoolName"
    }
} catch {
    Write-Log "IIS cleanup skipped/failed: $($_.Exception.Message)"
}

Write-Log "===== MMLPortal uninstall finished  -  PostgreSQL, .env, and logs left in place ====="
exit 0
