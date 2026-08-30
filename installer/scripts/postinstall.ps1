<#
.SYNOPSIS
    Non-interactive post-install provisioning for the MMLPortal offline installer.
    Invoked elevated from MMLPortal.iss's [Run] section after files are copied.

.DESCRIPTION
    Mirrors what scada-mml-backend\install.ps1 does interactively (NSSM registration, .env
    patching, health-check polling) plus everything install.ps1 does NOT do: silent
    PostgreSQL provisioning, IIS feature/module setup, IIS site + host-header binding, an
    optional self-signed HTTPS binding, and a hosts-file entry  -  all driven from wizard
    answers instead of console prompts.

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

.PARAMETER EnableHttps
    "true" to generate a self-signed certificate for -Hostname and bind it to the IIS site
    on -HttpsPort (in addition to the existing HTTP binding). "false" leaves the site
    HTTP-only. The public certificate is exported to {InstallDir}\certs\ so it can be pushed
    to other client machines' Trusted Root store  -  this server trusts it automatically,
    but nothing else on the LAN will until that certificate is imported there too.

.PARAMETER HttpsPort
    IIS HTTPS site port, used only when -EnableHttps is "true". Default 443.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$InstallDir,
    [Parameter(Mandatory)] [string]$Hostname,
    [int]$Port = 80,
    [string]$InstallPostgres = "true",
    [string]$ServiceName = "mml-api",
    [int]$ServicePort = 8088,
    [string]$EnableHttps = "false",
    [int]$HttpsPort = 443,
    [string]$AppDbName = "postgres",
    [string]$AppDbSchema = "public"
)

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1's .NET Framework HttpClient doesn't always default to TLS 1.2 on
# older Windows builds -- without this, Step 10's Invoke-RestMethod calls against an HTTPS
# binding (see Step 8b) can fail with a generic "could not create SSL/TLS secure channel"
# error that has nothing to do with the certificate itself.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

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
Write-Log "InstallDir=$InstallDir Hostname=$Hostname Port=$Port InstallPostgres=$InstallPostgres ServicePort=$ServicePort EnableHttps=$EnableHttps HttpsPort=$HttpsPort AppDbName=$AppDbName AppDbSchema=$AppDbSchema"

$PythonExe   = Join-Path $InstallDir "python\python.exe"
$BackendDir  = Join-Path $InstallDir "backend"
$StaticDir   = Join-Path $InstallDir "static"
$NssmExe     = Join-Path $InstallDir "tools\nssm.exe"
$RedistDir   = Join-Path $InstallDir "redist"
$envFile     = Join-Path $BackendDir ".env"

if (-not (Test-Path $PythonExe)) { Write-Log "FATAL: $PythonExe not found." "ERROR"; exit 1 }
if (-not (Test-Path $BackendDir)) { Write-Log "FATAL: $BackendDir not found." "ERROR"; exit 1 }

# -- Identifier validation ----------------------------------------------------------
# $AppDbName / $AppDbSchema get interpolated into a generated Python/SQL snippet below
# (Step 1c) -- postinstall.ps1 can be invoked directly, not only through the wizard (which
# already validates this), so re-check here too rather than trusting the caller.
$dbIdentifierPattern = '^[A-Za-z_][A-Za-z0-9_]{0,62}$'
if ($AppDbName -notmatch $dbIdentifierPattern) {
    Write-Log "AppDbName '$AppDbName' is not a safe identifier -- falling back to 'postgres'." "WARN"
    $AppDbName = "postgres"
}
if ($AppDbSchema -notmatch $dbIdentifierPattern) {
    Write-Log "AppDbSchema '$AppDbSchema' is not a safe identifier -- falling back to 'public'." "WARN"
    $AppDbSchema = "public"
}

# -- DPAPI helpers -------------------------------------------------------------------
# Encrypts/decrypts a plaintext string with Windows DPAPI at LocalMachine scope, usable by ANY
# account on this machine -- not just the encrypting one. That matters here because this
# script runs elevated as an interactive Administrator, but the mml-api service (via NSSM)
# runs as LocalSystem: two different security principals that both need to read secrets like
# JWT_SECRET/APP_DB_PASSWORD back out of .env at their own process start. Output is prefixed
# "dpapi:" so config.py's _resolve_secret() can tell an encrypted value apart from plaintext --
# mirrors security.py's "fernet$" prefix already used for datasource passwords at rest in the DB.
function Protect-DpapiSecret([string]$PlainText) {
    Add-Type -AssemblyName System.Security
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($PlainText)
    $protected = [System.Security.Cryptography.ProtectedData]::Protect(
        $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
    return "dpapi:" + [Convert]::ToBase64String($protected)
}

function Unprotect-DpapiSecret([string]$DpapiValue) {
    # Decrypts a dpapi:-prefixed value produced by Protect-DpapiSecret (or config.py's same
    # convention). Needed here -- not just in config.py -- because Step 1's PostgreSQL
    # connectivity check must test with the real plaintext password, which on a reinstall may
    # already be sitting in .env in encrypted form from a previous run.
    Add-Type -AssemblyName System.Security
    $encoded = $DpapiValue.Substring(6)   # strip "dpapi:"
    $bytes = [Convert]::FromBase64String($encoded)
    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
    return [System.Text.Encoding]::UTF8.GetString($plain)
}

# -- Resolve the app-DB password up front -------------------------------------------
# Step 1 (below) needs the plaintext password before .env is even written (Step 2) -- e.g. to
# hand to the bundled PostgreSQL installer's --superpassword, or to test connectivity against
# an already-provisioned instance.
$AppDbPasswordIsNew = $false
$existingAppDbPasswordRaw = $null
if (Test-Path $envFile) {
    $existingEnvContent = Get-Content $envFile -Raw
    if ($existingEnvContent -match '(?m)^APP_DB_PASSWORD=(.*)$') {
        $existingAppDbPasswordRaw = $Matches[1].Trim()
    }
}
# Whether PostgreSQL was already here before this run -- NOT whether .env exists. .env can be
# absent for reasons that have nothing to do with Postgres being fresh (an uninstall wipes the
# install dir, including .env, but never touches Postgres itself), so ".env is missing" must
# never be treated as "safe to mint a brand-new superuser password" on its own: Step 1 below
# only ever applies --superpassword when it *installs* PostgreSQL, i.e. when this service does
# NOT already exist. Minting a random secret whenever .env merely happened to be missing wrote
# a password into .env that was never actually set on a pre-existing Postgres instance --
# permanently breaking every DB connection until someone noticed and fixed it by hand.
$pgSvcPreExisting = Get-Service -Name "postgresql-x64-18" -ErrorAction SilentlyContinue
if ($existingAppDbPasswordRaw) {
    # Reinstall over an install that already migrated to this feature -- reuse as-is, whether
    # it's a dpapi: blob or (pre-migration hand-edited) plaintext.
    if ($existingAppDbPasswordRaw.StartsWith("dpapi:")) {
        $AppDbPassword = Unprotect-DpapiSecret $existingAppDbPasswordRaw
    } else {
        $AppDbPassword = $existingAppDbPasswordRaw
    }
} elseif ($pgSvcPreExisting) {
    # PostgreSQL already exists on this machine -- whether .env also exists (predates
    # APP_DB_PASSWORD) or not (wiped by an uninstall/reinstall cycle), Step 1 below will skip
    # the bundled installer entirely and never apply a new password to this instance. Fall back
    # to the legacy hardcoded default and let Step 1's connectivity check confirm/deny it
    # against the real instance instead of guessing with a secret Postgres never had.
    $AppDbPassword = "P@ssw0rd"
    $AppDbPasswordIsNew = $true
} else {
    # Genuinely fresh install -- no .env AND no pre-existing Postgres service -- safe to mint a
    # real per-install secret, since Step 1 will pass it as --superpassword to the installer
    # that is actually about to create this Postgres instance with it.
    $AppDbPassword = (& $PythonExe -c "import secrets; print(secrets.token_hex(24))").Trim()
    $AppDbPasswordIsNew = $true
}

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
    Write-Result "PostgreSQL connectivity (postgres user)" $pgCheckOk ($pgCheckOut -join " | ")
    if (-not $pgCheckOk) {
        Write-Log "PostgreSQL is running but the app's configured credentials (postgres user) don't work against it. This usually means a pre-existing PostgreSQL instance with a different superuser password. The backend will not be able to reach the database until this is resolved -- either reset the postgres user's password to match, or update .env's APP_DB_PASSWORD for this deployment." "WARN"
    }

    # -- Step 1c  -  ensure the configured database exists ---------------------------
    # The bundled PostgreSQL installer only ever creates the default "postgres" database --
    # nothing creates $AppDbName if the wizard/caller pointed this install at a different,
    # DBA-provisioned name (e.g. "mmllocal"). Idempotent: safe to run even when $AppDbName is
    # the "postgres" default, in which case it just logs "already exists". Schema creation
    # needs no installer-side step -- db.ensure_app_schema() already runs on every backend
    # boot and reads APP_DB_SCHEMA from .env.
    if ($pgCheckOk) {
        Write-Log "Step 1c: ensure database '$AppDbName' exists"
        $dbCreateScript = Join-Path $env:TEMP "mmlportal_dbcreate.py"
        @"
import sys
try:
    import psycopg
    from psycopg import sql
    conn = psycopg.connect(host="localhost", port=5432, dbname="postgres", user="postgres", password="$AppDbPassword", connect_timeout=5)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", ("$AppDbName",))
        if cur.fetchone():
            print("EXISTS")
        else:
            cur.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier("$AppDbName")))
            print("CREATED")
    conn.close()
except Exception as e:
    print("FAIL: " + str(e))
    sys.exit(1)
"@ | Set-Content -Path $dbCreateScript -Encoding utf8
        $dbCreateOut = & $PythonExe $dbCreateScript 2>&1
        $dbCreateOk = ($LASTEXITCODE -eq 0)
        Remove-Item $dbCreateScript -ErrorAction SilentlyContinue
        Write-Result "App database ($AppDbName)" $dbCreateOk ($dbCreateOut -join " | ")
    }
}

# -- Step 1b  -  undo any stale ACL lockdown from an older installer ------------------
# Older builds of this script locked backend\ down to SYSTEM + Administrators only via
# icacls /inheritance:r, and that restriction persists on disk across reinstalls/upgrades
# -- including onto THIS process, elevated as it is, which is exactly what broke a real
# install (Step 2 below got Access Denied reading .env and the whole script died silently,
# since Step 2 had no try/catch at the time). backend\ secret protection is now handled by
# DPAPI-encrypting the values themselves (see Protect-DpapiSecret above), not by an NTFS
# fence, so there is no reason to keep re-asserting one here -- just undo whatever a prior
# run may have left behind. /reset restores inherited ACEs and drops explicit ones; it does
# not apply a new lockdown. Non-fatal: a machine that never had the old lockdown has
# nothing to undo, and this must never be able to block Step 2 the way the old ACL did.
Write-Log "Step 1b: clearing any stale backend folder ACL lockdown from a prior install"
icacls $BackendDir /reset /T /C 2>$null | Out-Null

# -- Step 2  -  .env ---------------------------------------------------------------
Write-Log "Step 2: .env"
try {
    $envFile    = Join-Path $BackendDir ".env"
    $envExample = Join-Path $BackendDir ".env.example"
    $httpBaseUrl  = if ($Port -eq 80) { "http://$Hostname" } else { "http://${Hostname}:${Port}" }
    $httpsBaseUrl = if ($HttpsPort -eq 443) { "https://$Hostname" } else { "https://${Hostname}:${HttpsPort}" }
    # Password-reset links (APP_BASE_URL) should point at the encrypted site when one exists --
    # CORS_ORIGINS lists both so the API still accepts requests from whichever binding a browser
    # tab happens to be on (e.g. an old bookmark still using http://).
    $baseUrl     = if ($EnableHttps -eq "true") { $httpsBaseUrl } else { $httpBaseUrl }
    $corsOrigins = if ($EnableHttps -eq "true") { "$httpBaseUrl,$httpsBaseUrl" } else { $httpBaseUrl }

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
    # Mirror config.py's _INSECURE_JWT_SECRETS: .env.example ships JWT_SECRET set to a non-empty
    # placeholder ("change-me-to-a-long-random-string"), so a plain "is it set?" regex treats a
    # freshly-copied .env.example as already configured and never generates a real secret --
    # main.py's startup check then refuses to boot on every fresh install. Extract the actual
    # value and compare it against the same insecure set the backend itself checks.
    $currentJwt = $null
    if ($content -match '(?m)^JWT_SECRET=(.*)$') { $currentJwt = $Matches[1].Trim() }
    $insecureJwtValues = @('', 'dev-insecure-change-me', 'change-me-to-a-long-random-string')
    if (-not $currentJwt -or $insecureJwtValues -contains $currentJwt) {
        $jwtSecret = (& $PythonExe -c "import secrets; print(secrets.token_hex(32))").Trim()
        # Store only the DPAPI-wrapped form -- the plaintext $jwtSecret variable is never
        # written to disk or logged. A dpapi:-prefixed blob will never match any string in
        # $insecureJwtValues on a future run, so it is correctly treated as "already
        # configured" and left untouched -- this is what makes JWT_SECRET (and therefore
        # existing refresh-token cookies) survive a reinstall.
        $jwtSecretProtected = Protect-DpapiSecret $jwtSecret
        if ($content -match '(?m)^JWT_SECRET=') {
            $content = [regex]::Replace($content, '(?m)^JWT_SECRET=.*$', "JWT_SECRET=$jwtSecretProtected")
        } else {
            $content = $content.TrimEnd() + "`nJWT_SECRET=$jwtSecretProtected`n"
        }
    }
    if ($content -match '(?m)^APP_BASE_URL=') {
        $content = [regex]::Replace($content, '(?m)^APP_BASE_URL=.*$', "APP_BASE_URL=$baseUrl")
    } else {
        $content = $content.TrimEnd() + "`nAPP_BASE_URL=$baseUrl`n"
    }
    if ($content -match '(?m)^CORS_ORIGINS=') {
        $content = [regex]::Replace($content, '(?m)^CORS_ORIGINS=.*$', "CORS_ORIGINS=$corsOrigins")
    } else {
        $content = $content.TrimEnd() + "`nCORS_ORIGINS=$corsOrigins`n"
    }
    # APP_DB_NAME/APP_DB_SCHEMA: same "wizard always wins" treatment as APP_BASE_URL/CORS_ORIGINS
    # above -- a reinstall that points at a different DBA-provisioned database must not silently
    # keep serving the OLD database's config.
    if ($content -match '(?m)^APP_DB_NAME=') {
        $content = [regex]::Replace($content, '(?m)^APP_DB_NAME=.*$', "APP_DB_NAME=$AppDbName")
    } else {
        $content = $content.TrimEnd() + "`nAPP_DB_NAME=$AppDbName`n"
    }
    if ($content -match '(?m)^APP_DB_SCHEMA=') {
        $content = [regex]::Replace($content, '(?m)^APP_DB_SCHEMA=.*$', "APP_DB_SCHEMA=$AppDbSchema")
    } else {
        $content = $content.TrimEnd() + "`nAPP_DB_SCHEMA=$AppDbSchema`n"
    }
    # APP_DB_PASSWORD: same preserve-once-generated treatment as JWT_SECRET -- only written when
    # $AppDbPasswordIsNew (a genuinely fresh install, or an upgrade from a pre-APP_DB_PASSWORD
    # .env still on the legacy literal). An already-migrated dpapi: value is left untouched so a
    # reinstall never invalidates the real PostgreSQL password it was already set to.
    #
    # Also gated on $pgCheckOk (Step 1's connectivity probe against the real instance, using
    # this exact candidate password) -- belt-and-suspenders alongside the pre-existing-service
    # check above: a candidate that Step 1 already proved doesn't work must never be persisted.
    # Leaving APP_DB_PASSWORD unset in that case is safe -- config.py's own fallback for a
    # missing key is the same "P@ssw0rd" literal -- and it leaves a working dpapi: value from a
    # PRIOR successful run (if any) untouched instead of clobbering it with a known-bad one.
    if ($AppDbPasswordIsNew -and $pgCheckOk) {
        $appDbPasswordProtected = Protect-DpapiSecret $AppDbPassword
        if ($content -match '(?m)^APP_DB_PASSWORD=') {
            $content = [regex]::Replace($content, '(?m)^APP_DB_PASSWORD=.*$', "APP_DB_PASSWORD=$appDbPasswordProtected")
        } else {
            $content = $content.TrimEnd() + "`nAPP_DB_PASSWORD=$appDbPasswordProtected`n"
        }
    } elseif ($AppDbPasswordIsNew) {
        Write-Log "APP_DB_PASSWORD left untouched in .env -- the candidate password failed Step 1's connectivity check against the real PostgreSQL instance, so it was not written. Resolve the real 'postgres' role password (reset it to match, or run tools\protect-secret.ps1 with the real password and paste the result into APP_DB_PASSWORD in .env) before the backend can reach the database." "WARN"
    }
    $content | Out-File $envFile -Encoding utf8 -NoNewline
    Write-Result ".env configured" $true $(if ($isNewEnv) { "created $envFile" } else { "reconciled existing $envFile (JWT_SECRET preserved)" })
} catch {
    # Every other step in this script is best-effort/non-fatal -- this one wasn't, so a
    # permission or IO error here used to kill the entire install silently right after
    # logging "Step 2: .env", with no PASS/WARN line and no summary. Never again: log it
    # and keep going, same as every step below.
    Write-Result ".env configured" $false $_.Exception.Message
}

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
$seedScript = Join-Path $BackendDir "seed_users.pyc"
if (Test-Path $seedScript) {
    # Can't invoke `python seed_users.pyc` directly here: the bundled embeddable Python's
    # python3xx._pth file fully overrides sys.path init (isolated mode), which suppresses
    # the normal cwd-on-sys.path behavior a full Python install gives a directly-run script
    # -- so `import db`/`import security` inside seed_users fail with ModuleNotFoundError
    # even though those sibling .pyc files sit right next to it. `-m` doesn't help either,
    # since that same override also skips -m's usual cwd insertion. PYTHONPATH is ignored
    # too -- ._pth intentionally ignores it. uvicorn's own CLI sidesteps this by explicitly
    # doing `sys.path.insert(0, app_dir)` itself (see venv's uvicorn/main.py) before importing
    # the app; mirror that here for seed_users, then call main() explicitly since the
    # `if __name__ == "__main__"` guard never fires for an imported (not directly-run) module.
    $ErrorActionPreference = "Continue"
    $seedOut = & $PythonExe -c "import sys; sys.path.insert(0, r'$BackendDir'); import seed_users; seed_users.main()" 2>&1
    $seedOk = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = "Stop"
    Write-Result "Seed database" $seedOk ($seedOut -join " | ")
} else {
    Write-Result "Seed database" $false "seed_users.pyc not found"
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

    # Get-WebAppPoolState -ErrorAction SilentlyContinue does NOT reliably suppress a missing
    # pool: the IIS: PSDrive provider throws its ItemNotFoundException directly from the
    # provider layer ("Cannot find path 'IIS:\AppPools\MMLPortalPool' because it does not
    # exist."), which bypasses a cmdlet-level -ErrorAction and was escaping straight into this
    # try block's catch on every fresh install -- New-WebAppPool below was never reached, so
    # the site was never created (and Step 8b's HTTPS binding then failed too, since there was
    # no site to bind it to). Test-Path against the same PSDrive never throws for a missing
    # item; it just returns $false, which is what an existence check actually needs here.
    if (-not (Test-Path "IIS:\AppPools\MMLPortalPool")) {
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

# -- Step 8b  -  HTTPS (self-signed certificate) ---------------------------------------
Write-Log "Step 8b: HTTPS"
if ($EnableHttps -eq "true") {
    try {
        Import-Module WebAdministration -ErrorAction Stop

        # Reuse an existing, still-valid self-signed cert for this hostname across
        # upgrades/reinstalls instead of minting a new one every run -- a new cert would
        # invalidate any trust a client machine already established by importing the old
        # one into its Trusted Root store.
        $existingCert = Get-ChildItem Cert:\LocalMachine\My |
            Where-Object { $_.Subject -eq "CN=$Hostname" -and $_.NotAfter -gt (Get-Date) } |
            Sort-Object NotAfter -Descending | Select-Object -First 1

        if ($existingCert) {
            $cert = $existingCert
            Write-Log "Reusing existing self-signed certificate for $Hostname (thumbprint $($cert.Thumbprint), expires $($cert.NotAfter))."
        } else {
            $cert = New-SelfSignedCertificate -DnsName $Hostname -CertStoreLocation "Cert:\LocalMachine\My" `
                -FriendlyName "MMLPortal ($Hostname)" -NotAfter (Get-Date).AddYears(10) `
                -KeyExportPolicy Exportable -KeyUsage DigitalSignature, KeyEncipherment `
                -Type SSLServerAuthentication
            Write-Log "Generated new self-signed certificate for $Hostname (thumbprint $($cert.Thumbprint), valid until $($cert.NotAfter))."
        }

        # Trust it on this machine so the server itself doesn't show the browser warning --
        # this does NOT extend to other client PCs on the LAN, see the exported .cer below.
        $rootStore = Get-Item Cert:\LocalMachine\Root
        $rootStore.Open("ReadWrite")
        if (-not (Get-ChildItem Cert:\LocalMachine\Root -ErrorAction SilentlyContinue | Where-Object Thumbprint -eq $cert.Thumbprint)) {
            $rootStore.Add($cert)
        }
        $rootStore.Close()

        # Drop any stale HTTPS binding from a previous install/hostname before rebinding --
        # New-WebBinding fails on an existing identical binding, and a leftover binding
        # pointed at an old cert would otherwise shadow the fresh one below.
        Get-WebBinding -Name "MMLPortal" -Protocol "https" -ErrorAction SilentlyContinue | Remove-WebBinding -ErrorAction SilentlyContinue
        $sslBindingPath = "IIS:\SslBindings\0.0.0.0!$HttpsPort"
        if (Test-Path $sslBindingPath) { Remove-Item $sslBindingPath -ErrorAction SilentlyContinue }

        # SslFlags 1 = SNI-enabled -- required so this shared IP can present the right cert
        # for the host header instead of only ever answering with whichever cert bound first.
        New-WebBinding -Name "MMLPortal" -Protocol "https" -Port $HttpsPort -HostHeader $Hostname -SslFlags 1
        New-Item $sslBindingPath -Value $cert -SSLFlags 1 | Out-Null

        # Export the public cert (no private key) so it can be pushed to every OTHER PC that
        # will browse to this site -- importing it into their Trusted Root store is the only
        # way to clear the "Not secure" warning there; it cannot be done remotely from here.
        $certExportPath = Join-Path $InstallDir "certs\$Hostname.cer"
        New-Item -ItemType Directory -Force -Path (Split-Path $certExportPath) | Out-Null
        Export-Certificate -Cert $cert -FilePath $certExportPath -Type CERT | Out-Null

        Write-Result "HTTPS binding" $true "port $HttpsPort, thumbprint $($cert.Thumbprint)"
        Write-Log "Exported public certificate to $certExportPath -- import this into 'Trusted Root Certification Authorities' (Local Machine) on every OTHER PC that will browse to https://$Hostname to clear the browser warning there too (this server already trusts it)." "WARN"
    } catch {
        Write-Result "HTTPS binding" $false $_.Exception.Message
    }
} else {
    Write-Log "HTTPS disabled by installer choice -- site remains HTTP-only."
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
