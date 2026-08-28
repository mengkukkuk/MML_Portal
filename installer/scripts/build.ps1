<#
.SYNOPSIS
    Builds the offline MMLPortal installer end to end.

.DESCRIPTION
    Run on a developer machine (needs internet the first time, for pip-installing backend
    deps into the bundled Python and for `npm install`/`npm run build`). Produces a single
    installer\Output\MMLPortalSetup-<version>.exe that requires NO network access to run.

    Steps:
      1. Verify installer\redist\ is populated (run fetch-redist.ps1 first if not).
      2. Build the frontend (npm run build) -> installer\staging\static\
      3. Assemble a self-contained Python: unzip the embeddable distribution, enable
         site-packages, bootstrap pip, `pip install -r requirements.txt` straight into it.
         No venv layer  -  the folder itself is portable. -> installer\staging\python\
      4. Copy backend source (excluding venv/.env/logs/tests/__pycache__) -> installer\staging\backend\
      5. Copy nssm.exe -> installer\staging\tools\
      6. Invoke ISCC.exe (Inno Setup Compiler) against installer\MMLPortal.iss.

.PARAMETER Version
    Version string embedded in the installer filename and Inno's AppVersion. Default: read
    from scada-frontend\package.json "version" field.

.PARAMETER SkipFrontendBuild
    Skip `npm run build` and reuse whatever is already in scada-frontend\dist\ (faster
    iteration when only backend/installer script changes are being tested).

.PARAMETER SkipPythonBundle
    Skip rebuilding installer\staging\python\ (faster iteration when only frontend/backend
    source changed, not requirements.txt).

.EXAMPLE
    .\installer\scripts\build.ps1
.EXAMPLE
    .\installer\scripts\build.ps1 -SkipFrontendBuild -SkipPythonBundle
#>

[CmdletBinding()]
param(
    [string]$Version,
    [switch]$SkipFrontendBuild,
    [switch]$SkipPythonBundle
)

$ErrorActionPreference = "Stop"

$InstallerDir = Split-Path -Parent $PSScriptRoot
$RootDir      = Split-Path -Parent $InstallerDir
$RedistDir    = Join-Path $InstallerDir "redist"
$StagingDir   = Join-Path $InstallerDir "staging"
$OutputDir    = Join-Path $InstallerDir "Output"
$BackendSrc   = Join-Path $RootDir "scada-mml-backend"
$FrontendSrc  = Join-Path $RootDir "scada-frontend"

function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK([string]$msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Abort([string]$msg) {
    Write-Host "`n[FATAL] $msg" -ForegroundColor Red
    exit 1
}

if (-not $Version) {
    $pkg = Get-Content (Join-Path $FrontendSrc "package.json") -Raw | ConvertFrom-Json
    $Version = $pkg.version
    if (-not $Version) { $Version = "0.0.0" }
}
Write-Host "MMLPortal installer build  -  version $Version" -ForegroundColor Magenta

# -- Step 0  -  sanity: redist populated ----------------------------------------
Write-Step "Checking installer\redist\"
$requiredRedist = @(
    "postgresql-18-windows-x64.exe",
    "rewrite_amd64_en-US.msi",
    "requestRouter_amd64.msi",
    "python-3.14.0-embed-amd64.zip",
    "get-pip.py",
    "nssm.exe"
)
$missing = $requiredRedist | Where-Object { -not (Test-Path (Join-Path $RedistDir $_)) }
if ($missing) {
    Abort "Missing redistributable(s): $($missing -join ', ')`nRun .\installer\scripts\fetch-redist.ps1 first."
}
Write-OK "All redistributables present."

# -- Step 1  -  frontend build ---------------------------------------------------
if (-not $SkipFrontendBuild) {
    Write-Step "Building frontend (npm run build)"
    Push-Location $FrontendSrc
    try {
        & npm install
        if ($LASTEXITCODE -ne 0) { Abort "npm install failed." }
        & npm run build
        if ($LASTEXITCODE -ne 0) { Abort "npm run build failed." }
    } finally {
        Pop-Location
    }
    Write-OK "Frontend built."
} else {
    Write-Host "    (skipped  -  reusing existing scada-frontend\dist\)" -ForegroundColor Yellow
}

$distDir = Join-Path $FrontendSrc "dist"
if (-not (Test-Path (Join-Path $distDir "index.html"))) {
    Abort "scada-frontend\dist\index.html not found. Build the frontend first (drop -SkipFrontendBuild)."
}

Write-Step "Staging frontend -> installer\staging\static\"
$staticDest = Join-Path $StagingDir "static"
if (Test-Path $staticDest) { Remove-Item $staticDest -Recurse -Force }
Copy-Item $distDir $staticDest -Recurse
Write-OK "Copied $distDir -> $staticDest"

# -- Step 2  -  self-contained Python (embeddable + pip-installed deps) ---------
$pythonDest = Join-Path $StagingDir "python"
if (-not $SkipPythonBundle) {
    Write-Step "Assembling self-contained Python (embeddable + backend deps)"
    if (Test-Path $pythonDest) { Remove-Item $pythonDest -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $pythonDest | Out-Null

    Expand-Archive -Path (Join-Path $RedistDir "python-3.14.0-embed-amd64.zip") -DestinationPath $pythonDest -Force
    Write-OK "Expanded embeddable Python."

    # Enable site-packages: the embeddable distro ships with `import site` commented out
    # in its ._pth file, which also disables pip's own site-packages discovery.
    $pthFile = Get-ChildItem $pythonDest -Filter "python3*._pth" | Select-Object -First 1
    if (-not $pthFile) { Abort "Could not find python3*._pth in expanded embeddable distribution." }
    (Get-Content $pthFile.FullName) -replace '^#\s*import site$', 'import site' |
        Set-Content $pthFile.FullName -Encoding ascii
    Write-OK "Enabled site-packages in $($pthFile.Name)"

    $pythonExe = Join-Path $pythonDest "python.exe"

    # Enabling `import site` also makes Python honor the *user* site-packages directory
    # (e.g. %APPDATA%\Python\Python314\site-packages on the build machine). If the
    # developer's own Python already has a package installed there, pip sees it as
    # "already satisfied" and skips installing it into this embeddable folder -- silently
    # producing a staging\python\ that only works on the build machine, not the target PC.
    # PYTHONNOUSERSITE forces pip (and the interpreter) to ignore that directory so every
    # dependency is actually copied into staging\python\Lib\site-packages.
    $env:PYTHONNOUSERSITE = "1"
    try {
        Write-Host "    Bootstrapping pip..." -ForegroundColor Yellow
        & $pythonExe (Join-Path $RedistDir "get-pip.py") --no-warn-script-location
        if ($LASTEXITCODE -ne 0) { Abort "get-pip.py failed." }

        Write-Host "    Installing backend dependencies..." -ForegroundColor Yellow
        & $pythonExe -m pip install --no-warn-script-location -r (Join-Path $BackendSrc "requirements.txt")
        if ($LASTEXITCODE -ne 0) { Abort "pip install -r requirements.txt failed." }
    } finally {
        Remove-Item Env:\PYTHONNOUSERSITE -ErrorAction SilentlyContinue
    }

    $installedPkgs = Get-ChildItem (Join-Path $pythonDest "Lib\site-packages") -Directory -Filter "*.dist-info" |
        ForEach-Object { $_.Name }
    foreach ($required in @("starlette", "pydantic", "cryptography")) {
        if (-not ($installedPkgs -match "^$required-")) {
            Abort "Expected dependency '$required' missing from staging\python\Lib\site-packages -- pip likely resolved it against the build machine's user site-packages instead of installing it here."
        }
    }
    Write-OK "Self-contained Python ready at $pythonDest"
} else {
    Write-Host "    (skipped  -  reusing existing installer\staging\python\)" -ForegroundColor Yellow
    if (-not (Test-Path (Join-Path $pythonDest "python.exe"))) {
        Abort "installer\staging\python\python.exe not found. Drop -SkipPythonBundle to build it."
    }
}

# -- Step 3  -  backend source ---------------------------------------------------
Write-Step "Staging backend source -> installer\staging\backend\"
$backendDest = Join-Path $StagingDir "backend"
if (Test-Path $backendDest) { Remove-Item $backendDest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $backendDest | Out-Null

$excludeDirs  = @("venv", "logs", "tests", "__pycache__", ".pytest_cache", ".idea")
$excludeFiles = @(".env")

robocopy $BackendSrc $backendDest /E /XD $excludeDirs /XF $excludeFiles /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Abort "robocopy failed copying backend source (exit $LASTEXITCODE)." }
Write-OK "Backend source staged (excluded: $($excludeDirs -join ', '), $($excludeFiles -join ', '))"

# -- Step 4  -  tools (nssm.exe) --------------------------------------------------
Write-Step "Staging tools -> installer\staging\tools\"
$toolsDest = Join-Path $StagingDir "tools"
New-Item -ItemType Directory -Force -Path $toolsDest | Out-Null
Copy-Item (Join-Path $RedistDir "nssm.exe") (Join-Path $toolsDest "nssm.exe") -Force
Write-OK "nssm.exe staged."

# -- Step 5  -  compile the Inno Setup installer ----------------------------------
Write-Step "Compiling installer (ISCC.exe)"
$isccPath = $null
$isccCmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if ($isccCmd) { $isccPath = $isccCmd.Source }
if (-not $isccPath) {
    $candidates = @(
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 7\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 7\ISCC.exe"
    )
    # This dev machine's Inno Setup 7 install lives outside Program Files; also sweep
    # every drive root for an "Inno Setup *" folder as a last resort.
    $candidates += Get-ChildItem -Path "$($env:SystemDrive)\", "G:\" -Directory -Filter "Inno Setup*" -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName "ISCC.exe" }
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { $isccPath = $candidate; break }
    }
}
if (-not $isccPath) {
    Abort "ISCC.exe (Inno Setup Compiler) not found. Install Inno Setup 6 from https://jrsoftware.org/isdl.php or add ISCC.exe to PATH."
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$issPath = Join-Path $InstallerDir "MMLPortal.iss"

& $isccPath "/DMyAppVersion=$Version" $issPath
if ($LASTEXITCODE -ne 0) { Abort "ISCC.exe compilation failed (exit $LASTEXITCODE)." }

Write-Host "`n============================================================" -ForegroundColor Green
Write-Host "  Build complete: installer\Output\MMLPortalSetup-$Version.exe" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
