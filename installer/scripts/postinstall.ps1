<#
.SYNOPSIS
    Non-interactive post-install provisioning for the MMLPortal offline installer.
    Invoked elevated from MMLPortal.iss's [Run] section after files are copied.

.DESCRIPTION
    Mirrors what scada-mml-backend\install.ps1 does interactively (NSSM registration, .env
    patching, health-check polling) plus everything install.ps1 does NOT do: silent
    PostgreSQL provisioning, IIS feature/module setup, IIS site + host-header binding, and a
    hosts-file entry  -  all driven from wizard answers instead of console prompts.

    Every step is best-effort/non-fatal except where noted, matching install.ps1's philosophy:
    a plant-floor install should end with the service running and reachable even if one
    optional step (e.g. DB seed) couldn't complete yet.

.PARAMETER InstallDir
    Root install directory (Inno's {app}), e.g. C:\MMLPortal. Expected to already contain
    python\, static\, backend\, tools\ (copied by [Files]).

.PARAMETER Hostname
    Local hostname the site should answer on, e.g. mmlportal.local.

.PARAMETER Port
    IIS site port. Default 80.

.PARAMETER InstallPostgres
    "true" to silently install the bundled PostgreSQL 18; "false" to assume it's already
    present (checked either way).

.PARAMETER ServicePort
    Port the bundled uvicorn/NSSM service binds to on 127.0.0.1. Default 8088.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$InstallDir,
    [Parameter(Mandatory)] [string]$Hostname,
    [int]$Port = 80,
    [string]$InstallPostgres = "true",
    [string]$ServiceName = "mml-api",
    [int]$ServicePort = 8088
)

$ErrorActionPreference = "Stop"

$LogDir  = "C:\ProgramData\MMLPortal"
$LogFile = Join-Path $LogDir "install.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$script:Results = New-Object System.Collections.Generic.List[string]

function Write-Log([string]$msg, [string]$level = "INFO") {
    $line = "{0}  [{1}]  {2}" -f (Get-Date -Format "s"), $level, $msg
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}
function Write-Result([string]$step, [bool]$pass, [string]$detail = "") {
    $status = if ($pass) { "PASS" } else { "WARN" }
    $script:Results.Add("$status  $step  $detail")
    Write-Log "$step -> $status $detail" $(if ($pass) { "INFO" } else { "WARN" })
}

Write-Log "===== MMLPortal post-install starting ====="
Write-Log "InstallDir=$InstallDir Hostname=$Hostname Port=$Port InstallPostgres=$InstallPostgres ServicePort=$ServicePort"

$PythonExe   = Join-Path $InstallDir "python\python.exe"
$BackendDir  = Join-Path $InstallDir "backend"
$StaticDir   = Join-Path $InstallDir "static"
$NssmExe     = Join-Path $InstallDir "tools\nssm.exe"
$RedistDir   = Join-Path $InstallDir "redist"
$AppDbPassword = "P@ssw0rd"   # must match config.py's hardcoded APP_DB_PASSWORD  -  do not diverge

if (-not (Test-Path $PythonExe)) { Write-Log "FATAL: $PythonExe not found." "ERROR"; exit 1 }
if (-not (Test-Path $BackendDir)) { Write-Log "FATAL: $BackendDir not found." "ERROR"; exit 1 }

# -- Step 1  -  PostgreSQL --------------------------------------------------------
Write-Log "Step 1: PostgreSQL"

# A pre-existing PostgreSQL under a different major version's service name (e.g. from a
# manual install) won't be detected by the postgresql-x64-18 check below, but will likely
# already own port 5432 -- flag it now so a subsequent bundled-install failure below makes
# sense in the log instead of looking random.
$otherPgSvcs = Get-Service -Name "postgresql-x64-*" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne "postgresql-x64-18" }
if ($otherPgSvcs) {
    Write-Log "Found other PostgreSQL service(s) already installed: $($otherPgSvcs.Name -join ', '). These may already be bound to port 5432, which would make the bundled PostgreSQL 18 install/start fail on the same port." "WARN"
}

$pgSvc = Get-Service -Name "postgresql-x64-18" -ErrorAction SilentlyContinue
if (-not $pgSvc -and $InstallPostgres -eq "true") {
    $pgInstaller = Join-Path $RedistDir "postgresql-18-windows-x64.exe"
    if (Test-Path $pgInstaller) {
        Write-Log "Installing PostgreSQL 18 silently..."
        # NOTE: EDB's installbuilder-based installer. Flags verified against the version
        # pinned in fetch-redist.ps1  -  re-check `<installer>.exe --help` if that pin moves.
        $pgArgs = @(
            "--mode", "unattended",
            "--unattendedmodeui", "minimal",
            "--superpassword", $AppDbPassword,
            "--servicepassword", $AppDbPassword,
            "--servicename", "postgresql-x64-18",
            "--serverport", "5432",
            "--disable-stackbuilder", "1"
        )
        $proc = Start-Process -FilePath $pgInstaller -ArgumentList $pgArgs -Wait -PassThru
        if ($proc.ExitCode -ne 0) {
            Write-Result "PostgreSQL install" $false "installer exit code $($proc.ExitCode)"
        } else {
            Write-Result "PostgreSQL install" $true
        }
    } else {
        Write-Result "PostgreSQL install" $false "bundled installer not found at $pgInstaller"
    }
} elseif ($pgSvc) {
    Write-Result "PostgreSQL install" $true "service already present, skipped"
    if ($pgSvc.Status -ne "Running") {
        Write-Log "postgresql-x64-18 service found but status is $($pgSvc.Status) -- starting it." "WARN"
        Start-Service -Name "postgresql-x64-18" -ErrorAction SilentlyContinue
    }
} else {
    Write-Result "PostgreSQL install" $false "not installed and InstallPostgres=false  -  DB steps below will likely fail"
}

Write-Log "Waiting for postgresql-x64-18 service to report Running..."
$deadline = (Get-Date).AddSeconds(180)
do {
    Start-Sleep -Seconds 3
    $pgSvc = Get-Service -Name "postgresql-x64-18" -ErrorAction SilentlyContinue
} while ((-not $pgSvc -or $pgSvc.Status -ne "Running") -and (Get-Date) -lt $deadline)
Write-Result "PostgreSQL running" ($pgSvc -and $pgSvc.Status -eq "Running") "$($pgSvc.Status)"

# A "Running" service isn't enough: if this is a pre-existing instance with credentials that
# don't match config.py's hardcoded postgres/P@ssw0rd, the backend will start but every DB
# call will fail. Verify the actual credentials the app will use, not just that the service
# is up, so a mismatch is caught here instead of showing up as a mystery 500 later.
if ($pgSvc -and $pgSvc.Status -eq "Running") {
    $pgCheckScript = Join-Path $env:TEMP "mmlportal_pgcheck.py"
    @"
import sys
try:
    import psycopg
    conn = psycopg.connect(host="localhost", port=5432, dbname="postgres", user="postgres", password="$AppDbPassword", connect_timeout=5)
    conn.close()
    print("OK")
except Exception as e:
    print("FAIL: " + str(e))
    sys.exit(1)
"@ | Set-Content -Path $pgCheckScript -Encoding utf8
    $pgCheckOut = & $PythonExe $pgCheckScript 2>&1
    $pgCheckOk = ($LASTEXITCODE -eq 0)
    Remove-Item $pgCheckScript -ErrorAction SilentlyContinue
    Write-Result "PostgreSQL connectivity (postgres/$AppDbPassword)" $pgCheckOk ($pgCheckOut -join " | ")
    if (-not $pgCheckOk) {
        Write-Log "PostgreSQL is running but the app's hardcoded credentials (postgres/$AppDbPassword) don't work against it. This usually means a pre-existing PostgreSQL instance with a different superuser password. The backend will not be able to reach the database until this is resolved -- either reset the postgres user's password to match, or update config.py's APP_DB_* constants for this deployment." "WARN"
    }
}

# -- Step 2  -  .env ---------------------------------------------------------------
Write-Log "Step 2: .env"
$envFile    = Join-Path $BackendDir ".env"
$envExample = Join-Path $BackendDir ".env.example"
$baseUrl    = if ($Port -eq 80) { "http://$Hostname" } else { "http://${Hostname}:${Port}" }

$isNewEnv = -not (Test-Path $envFile)
if ($isNewEnv) {
    Copy-Item $envExample $envFile
}

# Whether .env pre-existed (reinstall/upgrade over a prior install) or was just created,
# always reconcile APP_BASE_URL/CORS_ORIGINS to the hostname/port the wizard was just run
# with -- otherwise a reinstall that changes the hostname silently keeps serving the OLD
# hostname's CORS/base-URL config, which breaks login through IIS with no obvious cause.
# JWT_SECRET is only ever generated once and is preserved across reinstalls so existing
# refresh-token cookies from a prior install stay valid.
$content = Get-Content $envFile -Raw
if ($content -notmatch '(?m)^JWT_SECRET=\S') {
    $jwtSecret = & $PythonExe -c "import secrets; print(secrets.token_hex(32))"
    if ($content -match '(?m)^JWT_SECRET=') {
        $content = [regex]::Replace($content, '(?m)^JWT_SECRET=.*$', "JWT_SECRET=$jwtSecret")
    } else {
        $content = $content.TrimEnd() + "`nJWT_SECRET=$jwtSecret`n"
    }
}
if ($content -match '(?m)^APP_BASE_URL=') {
    $content = [regex]::Replace($content, '(?m)^APP_BASE_URL=.*$', "APP_BASE_URL=$baseUrl")
} else {
    $content = $content.TrimEnd() + "`nAPP_BASE_URL=$baseUrl`n"
}
if ($content -match '(?m)^CORS_ORIGINS=') {
    $content = [regex]::Replace($content, '(?m)^CORS_ORIGINS=.*$', "CORS_ORIGINS=$baseUrl")
} else {
    $content = $content.TrimEnd() + "`nCORS_ORIGINS=$baseUrl`n"
}
$content | Out-File $envFile -Encoding utf8 -NoNewline
Write-Result ".env configured" $true $(if ($isNewEnv) { "created $envFile" } else { "reconciled existing $envFile (JWT_SECRET preserved)" })

# -- Step 3  -  NSSM service --------------------------------------------------------
Write-Log "Step 3: NSSM service '$ServiceName'"
if (-not (Test-Path $NssmExe)) {
    Write-Result "NSSM service" $false "nssm.exe not found at $NssmExe"
} else {
    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existing) {
        & $NssmExe stop $ServiceName confirm 2>$null
        Start-Sleep -Seconds 2
        & $NssmExe remove $ServiceName confirm
        Start-Sleep -Seconds 1
    }
    $uvicornArgs = "-m uvicorn main:app --host 127.0.0.1 --port $ServicePort"
    & $NssmExe install $ServiceName $PythonExe $uvicornArgs
    & $NssmExe set $ServiceName AppDirectory        $BackendDir
    & $NssmExe set $ServiceName DisplayName         "MML Portal API"
    & $NssmExe set $ServiceName Description         "MML Portal backend - FastAPI/uvicorn on port $ServicePort"
    & $NssmExe set $ServiceName Start               SERVICE_AUTO_START
    $logDir = Join-Path $BackendDir "logs"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    & $NssmExe set $ServiceName AppStdout           (Join-Path $logDir "stdout.log")
    & $NssmExe set $ServiceName AppStderr           (Join-Path $logDir "stderr.log")
    & $NssmExe set $ServiceName AppRotateFiles      1
    & $NssmExe set $ServiceName AppRotateSeconds    86400
    & $NssmExe set $ServiceName AppEnvironmentExtra "PYTHONUNBUFFERED=1"

    # A stale process from a previous failed install, or an unrelated app, may already be
    # bound to 127.0.0.1:$ServicePort -- NSSM will "start" the service happily even though
    # uvicorn immediately dies inside it, so this needs to be caught here rather than
    # discovered later as a mysterious "Backend /health" failure in Step 10.
    $portBusy = $false
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $ServicePort)
        $listener.Start()
        $listener.Stop()
    } catch {
        $portBusy = $true
    }
    if ($portBusy) {
        $holder = Get-NetTCPConnection -LocalPort $ServicePort -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1 -ExpandProperty OwningProcess
        $holderName = if ($holder) { (Get-Process -Id $holder -ErrorAction SilentlyContinue).ProcessName } else { $null }
        Write-Log "Port $ServicePort is already in use$(if ($holderName) { " by process '$holderName' (PID $holder)" }) -- the mml-api service will fail to bind. Free the port (stop the conflicting process) or re-run with a different -ServicePort." "WARN"
    }

    Start-Service $ServiceName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 4
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    Write-Result "NSSM service running" ($svc -and $svc.Status -eq "Running") "$($svc.Status)"
}

# -- Step 4  -  seed DB --------------------------------------------------------------
Write-Log "Step 4: seed database"
$seedScript = Join-Path $BackendDir "seed_users.py"
if (Test-Path $seedScript) {
    $ErrorActionPreference = "Continue"
    $seedOut = & $PythonExe $seedScript 2>&1
    $seedOk = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = "Stop"
    Write-Result "Seed database" $seedOk ($seedOut -join " | ")
} else {
    Write-Result "Seed database" $false "seed_users.py not found"
}

# -- Step 5  -  IIS Windows features -------------------------------------------------
Write-Log "Step 5: enabling IIS Windows features"
$features = @(
    "IIS-WebServerRole", "IIS-WebServer", "IIS-CommonHttpFeatures", "IIS-StaticContent",
    "IIS-DefaultDocument", "IIS-HttpErrors", "IIS-HttpRedirect", "IIS-ApplicationDevelopment",
    "IIS-ISAPIExtensions", "IIS-ISAPIFilter", "IIS-HttpLogging", "IIS-RequestFiltering",
    "IIS-WebSockets", "IIS-ManagementConsole", "IIS-ManagementScriptingTools"
)
$featureFailures = @()
$restartNeeded = $false
foreach ($f in $features) {
    try {
        $result = Enable-WindowsOptionalFeature -Online -FeatureName $f -All -NoRestart -ErrorAction Stop
        if ($result -and $result.RestartNeeded) { $restartNeeded = $true }
    } catch {
        $featureFailures += $f
        Write-Log "Could not enable feature $f : $($_.Exception.Message)" "WARN"
    }
}
Write-Result "IIS Windows features" ($featureFailures.Count -eq 0) $(if ($featureFailures) { "failed: $($featureFailures -join ', ')" } else { "" })
if ($restartNeeded) {
    Write-Log "Windows reports a restart is needed to finish enabling one or more IIS features. IIS/ARR may not function correctly until this PC is rebooted -- reboot it after this installer finishes, then re-run verify_prod.ps1 or reopen the site." "WARN"
}

# -- Step 6  -  URL Rewrite + ARR MSIs -----------------------------------------------
Write-Log "Step 6: URL Rewrite + Application Request Routing"
function Install-Msi([string]$path, [string]$label) {
    if (-not (Test-Path $path)) { Write-Result $label $false "installer not found: $path"; return }
    $msiLog = Join-Path $LogDir ("msi_" + [IO.Path]::GetFileNameWithoutExtension($path) + ".log")
    $proc = Start-Process msiexec.exe -ArgumentList @("/i", "`"$path`"", "/quiet", "/norestart", "/log", "`"$msiLog`"") -Wait -PassThru
    # 0 = success, 3010 = success, reboot required later (not fatal for our purposes)
    Write-Result $label ($proc.ExitCode -in @(0, 3010)) "exit $($proc.ExitCode)"
}
Install-Msi (Join-Path $RedistDir "rewrite_amd64_en-US.msi") "URL Rewrite install"
Install-Msi (Join-Path $RedistDir "requestRouter_amd64.msi") "ARR install"

Write-Log "Restarting IIS so newly installed modules register..."
iisreset /noforce | Out-Null

# -- Step 7  -  enable ARR proxy at server level -------------------------------------
Write-Log "Step 7: enabling ARR proxy"
try {
    Import-Module WebAdministration -ErrorAction Stop
    Set-WebConfigurationProperty -pspath "MACHINE/WEBROOT/APPHOST" -filter "system.webServer/proxy" -name "enabled" -value "True"
    Write-Result "ARR proxy enabled" $true
} catch {
    Write-Result "ARR proxy enabled" $false $_.Exception.Message
}

# -- Step 8  -  IIS site --------------------------------------------------------------
Write-Log "Step 8: IIS site"
try {
    Import-Module WebAdministration -ErrorAction Stop

    $defaultSite = Get-Website -Name "Default Web Site" -ErrorAction SilentlyContinue
    if ($defaultSite) {
        $conflict = $defaultSite.bindings.Collection | Where-Object {
            $_.bindingInformation -match "^\*?:$Port`:$" -or $_.bindingInformation -match "^:$Port`:$"
        }
        if ($conflict) {
            Write-Log "Default Web Site has a wildcard binding on port $Port  -  this will conflict with the MMLPortal host-header binding. Consider stopping/rebinding Default Web Site." "WARN"
        }
    }

    if (-not (Get-WebAppPoolState -Name "MMLPortalPool" -ErrorAction SilentlyContinue)) {
        New-WebAppPool -Name "MMLPortalPool" | Out-Null
    }
    Set-ItemProperty "IIS:\AppPools\MMLPortalPool" -Name managedRuntimeVersion -Value ""

    if (Get-Website -Name "MMLPortal" -ErrorAction SilentlyContinue) {
        Remove-Website -Name "MMLPortal"
    }
    New-Website -Name "MMLPortal" -PhysicalPath $StaticDir -Port $Port -HostHeader $Hostname -ApplicationPool "MMLPortalPool" | Out-Null

    Write-Result "IIS site created" $true "MMLPortal -> $StaticDir (host header: $Hostname`:$Port)"
} catch {
    Write-Result "IIS site created" $false $_.Exception.Message
}

# -- Step 9  -  hosts file -------------------------------------------------------------
Write-Log "Step 9: hosts file entry"
$hostsPath = "$env:WinDir\System32\drivers\etc\hosts"
try {
    $hostsContent = Get-Content $hostsPath -ErrorAction Stop
    if ($hostsContent -notmatch "\s$([regex]::Escape($Hostname))\s*$") {
        Add-Content -Path $hostsPath -Value "127.0.0.1`t$Hostname"
        Write-Result "Hosts file entry" $true "added 127.0.0.1  $Hostname"
    } else {
        Write-Result "Hosts file entry" $true "already present"
    }
    Write-Log "NOTE: other PCs on the LAN need their own hosts entry (pointing at this server's real LAN IP, not 127.0.0.1) or a DNS A record for '$Hostname' to resolve it." "WARN"
} catch {
    Write-Result "Hosts file entry" $false $_.Exception.Message
}

# -- Step 10  -  verification ----------------------------------------------------------
Write-Log "Step 10: verification"
Start-Sleep -Seconds 2
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$ServicePort/health" -TimeoutSec 10
    Write-Result "Backend /health" ($health.status -eq "ok") ($health | ConvertTo-Json -Compress)
} catch {
    Write-Result "Backend /health" $false $_.Exception.Message
}

try {
    $r = Invoke-RestMethod -Uri "$baseUrl/api/auth/login" -Method Post -ContentType "application/json" `
         -Body '{"username":"admin","password":"admin123"}' -TimeoutSec 10 -Headers @{ Host = $Hostname }
    Write-Result "Login through IIS proxy" ([bool]$r.access_token) "$baseUrl/api/auth/login"
} catch {
    Write-Result "Login through IIS proxy" $false $_.Exception.Message
}

# -- Summary ---------------------------------------------------------------------------
Write-Log "===== MMLPortal post-install finished ====="
Write-Log ("Summary:`n" + ($script:Results -join "`n"))
Write-Host "`nFull log: $LogFile" -ForegroundColor Yellow
Write-Host "Access the app at: $baseUrl" -ForegroundColor Green

exit 0
