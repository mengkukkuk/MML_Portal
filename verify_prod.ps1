# SCADA production verification — RUN AS ADMINISTRATOR.
# Collects all output into an ordered report and writes it to C:\dev\verify_prod.log
# (so it can be read back reliably), and also prints to the console.

$ErrorActionPreference = 'Continue'
$out = New-Object System.Collections.Generic.List[string]
function Line($m) { $out.Add($m); Write-Host $m }

Line "===== SCADA PROD VERIFY  $(Get-Date -Format s) ====="

# --- 1. Service ---
Line ""
Line "## 1. NSSM backend service"
Start-Service mml-api -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
$svc = Get-Service mml-api -ErrorAction SilentlyContinue
Line ("   service status : {0}" -f $svc.Status)
$lis = Get-NetTCPConnection -LocalPort 8088 -State Listen -ErrorAction SilentlyContinue
Line ("   8088 listening : {0}" -f [bool]$lis)

# --- 2. Backend direct ---
Line ""
Line "## 2. Backend direct (http://127.0.0.1:8088/api/auth/login)"
try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8088/api/auth/login' -Method Post -ContentType 'application/json' -Body '{"username":"admin","password":"admin123"}' -TimeoutSec 10
    Line ("   RESULT : {0}" -f ($(if ($r.access_token) { "PASS  user=$($r.user.username) role=$($r.user.role)" } else { "FAIL  no access_token" })))
} catch { Line ("   RESULT : FAIL  $($_.Exception.Message)") }

# --- 3. Enumerate ALL IIS sites (ground truth) ---
Line ""
Line "## 3. IIS sites"
Import-Module IISAdministration -ErrorAction SilentlyContinue
$scadaUrl = $null
foreach ($s in (Get-IISSite)) {
    $bindStrs = @()
    foreach ($b in $s.Bindings) { $bindStrs += ("{0}|{1}" -f $b.Protocol, $b.BindingInformation) }
    $phys = @()
    foreach ($app in $s.Applications) { foreach ($vd in $app.VirtualDirectories) { $phys += $vd.PhysicalPath } }
    Line ("   - {0} [{1}]  bindings: {2}  paths: {3}" -f $s.Name, $s.State, ($bindStrs -join ', '), ($phys -join '; '))

    if (($phys -join ';') -like '*scada-frontend*' -and -not $scadaUrl) {
        $hb = $s.Bindings | Where-Object { $_.Protocol -in @('http','https') } | Select-Object -First 1
        if ($hb) {
            $bi = [string]$hb.BindingInformation          # ip:port:host
            $parts = $bi.Split(':')
            $ip = $parts[0]; $port = $parts[1]; $hh = $parts[2]
            $h = if ($hh) { $hh } elseif ($ip -and $ip -ne '*' -and $ip -ne '0.0.0.0') { $ip } else { 'localhost' }
            $scadaUrl = ("{0}://{1}:{2}" -f $hb.Protocol, $h, $port)
        }
    }
}
Line ("   scada site URL : {0}" -f $(if ($scadaUrl) { $scadaUrl } else { 'NOT FOUND' }))

# --- 4. ARR proxy enabled (read applicationHost.config directly) ---
Line ""
Line "## 4. ARR proxy"
try {
    [xml]$ah = Get-Content "$env:windir\System32\inetsrv\config\applicationHost.config"
    $proxyNode = $ah.configuration.'system.webServer'.proxy
    if ($null -ne $proxyNode) { Line ("   proxy enabled  : {0}" -f $proxyNode.enabled) }
    else { Line "   proxy enabled  : (no <proxy> node found -> ARR proxy NOT configured/enabled)" }
} catch { Line ("   proxy check    : ERROR $($_.Exception.Message)") }

# --- 5 & 6. Through the IIS reverse proxy ---
Line ""
Line "## 5. Login THROUGH IIS reverse proxy"
if ($scadaUrl) {
    try {
        $r2 = Invoke-RestMethod -Uri "$scadaUrl/api/auth/login" -Method Post -ContentType 'application/json' -Body '{"username":"admin","password":"admin123"}' -TimeoutSec 10
        Line ("   {0}/api/auth/login -> {1}" -f $scadaUrl, $(if ($r2.access_token) { "PASS user=$($r2.user.username)" } else { "FAIL no token" }))
    } catch { Line ("   {0}/api/auth/login -> FAIL  $($_.Exception.Message)" -f $scadaUrl) }

    Line ""
    Line "## 6. SPA fallback"
    try {
        $html = Invoke-WebRequest -Uri "$scadaUrl/login" -TimeoutSec 10 -UseBasicParsing
        Line ("   {0}/login -> status {1}, has #app: {2}" -f $scadaUrl, $html.StatusCode, ($html.Content -match 'id="app"'))
    } catch { Line ("   {0}/login -> FAIL  $($_.Exception.Message)" -f $scadaUrl) }
} else {
    Line "   SKIPPED — no scada site URL resolved (see section 3). Create an IIS site pointing at C:\dev\scada-frontend\dist."
}

Line ""
Line "===== END ====="
$out | Set-Content -Path 'C:\dev\verify_prod.log' -Encoding UTF8
Write-Host "`nWrote C:\dev\verify_prod.log" -ForegroundColor Yellow
