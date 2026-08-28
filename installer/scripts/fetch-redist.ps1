<#
.SYNOPSIS
    Downloads third-party redistributables needed by the offline MMLPortal installer.

.DESCRIPTION
    Run this ONCE on a developer machine that has internet access. It populates
    installer\redist\ (gitignored) with everything build.ps1 and MMLPortal.iss need to
    produce an installer that itself requires no network access on the target PC:

      - PostgreSQL 18 Windows x64 offline installer (EDB)
      - IIS URL Rewrite Module 2.1
      - IIS Application Request Routing 3.0
      - Python 3.14 embeddable (amd64) zip
      - get-pip.py bootstrap script

    Idempotent: skips any file already present in installer\redist\. Re-run any time to
    pick up newer versions after bumping the URLs below.

.EXAMPLE
    .\installer\scripts\fetch-redist.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$RootDir   = Split-Path -Parent $PSScriptRoot
$RedistDir = Join-Path $RootDir "redist"
New-Item -ItemType Directory -Force -Path $RedistDir | Out-Null

function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK([string]$msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Skip([string]$msg) { Write-Host "    [SKIP] $msg" -ForegroundColor Yellow }

# Version pins  -  bump here when a newer build is needed. Keep in sync with
# README.md's "Required stacks" table (PostgreSQL 18, Python 3.14).
$Assets = @(
    @{
        Name = "PostgreSQL 18 Windows x64 installer"
        File = "postgresql-18-windows-x64.exe"
        Url  = "https://get.enterprisedb.com/postgresql/postgresql-18.6-1-windows-x64.exe"
    },
    @{
        Name = "IIS URL Rewrite Module 2.1 (x64)"
        File = "rewrite_amd64_en-US.msi"
        Url  = "https://download.microsoft.com/download/1/2/8/128E2E22-C1B9-44A4-BE2A-5859ED1D4592/rewrite_amd64_en-US.msi"
    },
    @{
        Name = "IIS Application Request Routing 3.0 (x64)"
        File = "requestRouter_amd64.msi"
        Url  = "https://download.microsoft.com/download/E/9/8/E9849D6A-020E-47E4-9FD0-A023E99B54EB/requestRouter_amd64.msi"
    },
    @{
        Name = "Python 3.14 embeddable (amd64)"
        File = "python-3.14.0-embed-amd64.zip"
        Url  = "https://www.python.org/ftp/python/3.14.0/python-3.14.0-embed-amd64.zip"
    },
    @{
        Name = "get-pip.py bootstrap"
        File = "get-pip.py"
        Url  = "https://bootstrap.pypa.io/get-pip.py"
    }
)

Write-Step "Fetching redistributables into $RedistDir"

foreach ($asset in $Assets) {
    $dest = Join-Path $RedistDir $asset.File
    if (Test-Path $dest) {
        Write-Skip "$($asset.Name) already present: $($asset.File)"
        continue
    }
    Write-Host "    Downloading $($asset.Name)..." -ForegroundColor Yellow
    try {
        Invoke-WebRequest -Uri $asset.Url -OutFile $dest -UseBasicParsing
        Write-OK "$($asset.File) ($([math]::Round((Get-Item $dest).Length / 1MB, 1)) MB)"
    } catch {
        if (Test-Path $dest) { Remove-Item $dest -Force }
        Write-Host "    [FATAL] Failed to download $($asset.Name): $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "    Verify the URL is still current and retry, or download manually to $dest" -ForegroundColor Red
        exit 1
    }
}

# nssm.exe is already vendored in the repo  -  copy it in rather than fetching, so it
# stays byte-identical to the one scada-mml-backend\install.ps1 uses.
$nssmSrc = Join-Path $RootDir "..\scada-mml-backend\nssm.exe"
$nssmDst = Join-Path $RedistDir "nssm.exe"
if (-not (Test-Path $nssmDst)) {
    if (Test-Path $nssmSrc) {
        Copy-Item $nssmSrc $nssmDst
        Write-OK "Copied vendored nssm.exe from scada-mml-backend\"
    } else {
        Write-Host "    [WARN] scada-mml-backend\nssm.exe not found  -  installer\redist\nssm.exe missing." -ForegroundColor Yellow
    }
} else {
    Write-Skip "nssm.exe already present"
}

Write-Host "`nAll redistributables ready in $RedistDir" -ForegroundColor Green
Write-Host "Next: .\installer\scripts\build.ps1" -ForegroundColor Green
