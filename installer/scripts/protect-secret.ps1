<#
.SYNOPSIS
    Converts a plaintext secret into the dpapi: form config.py expects in .env.

.DESCRIPTION
    Run this ON THE TARGET MACHINE (not the build machine) after typing a real value for
    SMTP_PASS, BREVO_API_KEY, or ENCRYPTION_KEY into backend\.env. Unlike JWT_SECRET (which
    postinstall.ps1 generates and encrypts automatically on install), these are typed in by
    an operator after the fact, so there is no automatic step to protect them.

    Uses Windows DPAPI at LocalMachine scope -- the output only decrypts on THIS machine, by
    ANY account on it (so both an elevated admin console and the LocalSystem-run mml-api
    service can read it back), and never on a different machine, by design.

.PARAMETER PlainText
    The secret to encrypt. If omitted, you will be prompted for it (so it isn't left behind
    in shell history / Get-History).

.EXAMPLE
    C:\MMLPortal\tools\protect-secret.ps1
    (prompts, then prints a line like: dpapi:AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA...)
    Paste that whole line as the value in .env, e.g.:
        SMTP_PASS=dpapi:AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA...
#>
[CmdletBinding()]
param(
    [string]$PlainText
)

if (-not $PlainText) {
    $secure = Read-Host -Prompt "Enter the secret to protect" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $PlainText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

if (-not $PlainText) {
    Write-Host "No secret entered -- nothing to do." -ForegroundColor Yellow
    exit 1
}

Add-Type -AssemblyName System.Security
$bytes = [System.Text.Encoding]::UTF8.GetBytes($PlainText)
$protected = [System.Security.Cryptography.ProtectedData]::Protect(
    $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
$result = "dpapi:" + [Convert]::ToBase64String($protected)

Write-Host "`nPaste this as the value in backend\.env:" -ForegroundColor Cyan
Write-Host $result -ForegroundColor Green
