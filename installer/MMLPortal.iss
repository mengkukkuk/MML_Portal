; MMLPortal offline installer  -  Inno Setup script.
;
; Produced by installer\scripts\build.ps1, which assembles installer\staging\ and
; installer\redist\ (both gitignored  -  see installer\.gitignore) and then invokes ISCC.exe
; against this file. Do not run ISCC.exe directly without running build.ps1 first: staging\
; and redist\ won't exist.
;
; Everything the target PC needs is bundled: a self-contained Python (embeddable + backend
; deps pre-installed), the built frontend, nssm.exe, and the PostgreSQL/URL-Rewrite/ARR
; redistributables. No internet access is required at install time.

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

#define MyAppName "MMLPortal"
#define MyAppPublisher "MMLPortal"

[Setup]
AppId={{6F4E2C6A-6B1E-4B3E-9C7D-3F6E7C6E9A11}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName=C:\MMLPortal
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=Output
OutputBaseFilename=MMLPortalSetup-{#MyAppVersion}
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\static\favicon.svg
DisableWelcomePage=no
; Industrial network install: no code signing certificate is assumed. Add SignTool= here
; once the org has one.

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "staging\python\*";  DestDir: "{app}\python";  Flags: recursesubdirs createallsubdirs ignoreversion
Source: "staging\static\*";  DestDir: "{app}\static";   Flags: recursesubdirs createallsubdirs ignoreversion
Source: "staging\backend\*"; DestDir: "{app}\backend";  Flags: recursesubdirs createallsubdirs ignoreversion
Source: "staging\tools\*";   DestDir: "{app}\tools";    Flags: recursesubdirs createallsubdirs ignoreversion
Source: "redist\postgresql-18-windows-x64.exe"; DestDir: "{app}\redist"; Flags: ignoreversion
Source: "redist\rewrite_amd64_en-US.msi";       DestDir: "{app}\redist"; Flags: ignoreversion
Source: "redist\requestRouter_amd64.msi";       DestDir: "{app}\redist"; Flags: ignoreversion
Source: "scripts\postinstall.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "scripts\uninstall.ps1";   DestDir: "{app}\scripts"; Flags: ignoreversion

[Run]
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\postinstall.ps1"" -InstallDir ""{app}"" -Hostname ""{code:GetHostname}"" -Port {code:GetPort} -InstallPostgres {code:GetInstallPostgres}"; \
    StatusMsg: "Configuring PostgreSQL, IIS, and the MMLPortal service  -  this can take several minutes..."; \
    Flags: waituntilterminated

[UninstallRun]
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\uninstall.ps1"" -InstallDir ""{app}"""; \
    Flags: waituntilterminated runhidden; RunOnceId: "MMLPortalUninstall"

[Code]
var
  HostnamePage: TInputQueryWizardPage;
  PostgresPage: TInputOptionWizardPage;

function DetectExistingPostgres(): Boolean;
begin
  { The EDB installer registers its service under this key; presence here means a Postgres
    18 service already exists on this machine, so the checkbox should default to unchecked. }
  Result := RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\postgresql-x64-18');
end;

procedure InitializeWizard();
begin
  HostnamePage := CreateInputQueryPage(wpSelectDir,
    'Local network address', 'How will operators reach MMLPortal on this network?',
    'Choose the hostname and port the site will answer on. Other PCs on the same LAN will ' +
    'need their own hosts-file entry or a DNS record pointing this hostname at this ' +
    'server''s IP address to browse to it  -  this installer only configures the server ' +
    'itself.');
  HostnamePage.Add('Local hostname (e.g. mmlportal.local):', False);
  HostnamePage.Add('Port:', False);
  HostnamePage.Values[0] := 'mmlportal.local';
  HostnamePage.Values[1] := '80';

  PostgresPage := CreateInputOptionPage(HostnamePage.ID,
    'Database', 'PostgreSQL 18 is required for MMLPortal to store configuration and data.',
    'Leave this checked on a blank PC. If PostgreSQL 18 is already installed and running, ' +
    'it will be detected automatically and this option is unchecked for you.',
    False, False);
  PostgresPage.Add('Install bundled PostgreSQL 18 silently');
  PostgresPage.Values[0] := not DetectExistingPostgres();
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = HostnamePage.ID then
  begin
    if Trim(HostnamePage.Values[0]) = '' then
    begin
      MsgBox('Please enter a local hostname.', mbError, MB_OK);
      Result := False;
    end
    else if (StrToIntDef(HostnamePage.Values[1], -1) < 1) or
            (StrToIntDef(HostnamePage.Values[1], -1) > 65535) then
    begin
      MsgBox('Please enter a valid port number (1-65535).', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function GetHostname(Param: string): string;
begin
  Result := Trim(HostnamePage.Values[0]);
end;

function GetPort(Param: string): string;
begin
  Result := Trim(HostnamePage.Values[1]);
end;

function GetInstallPostgres(Param: string): string;
begin
  if PostgresPage.Values[0] then
    Result := 'true'
  else
    Result := 'false';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssInstall then
  begin
    { Stop the running service first, if present, so its python.exe isn't locked when the
      stale-file wipe below tries to remove staging\python (upgrade over a previous install).
      Ignore failures -- the service won't exist yet on a first-time install. }
    Exec(ExpandConstant('{sys}\net.exe'), 'stop mml-api', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

    { [Files] below always fully replaces these three folders with ignoreversion, but it
      never deletes a file that existed in a previous build and was since removed (a retired
      Python module, an old nssm.exe). Wipe them first on every (re)install so an upgrade
      never leaves stale files behind. backend\ is deliberately excluded here -- it's where
      .env and logs\ live, both of which must survive an upgrade. }
    DelTree(ExpandConstant('{app}\python'), True, True, True);
    DelTree(ExpandConstant('{app}\static'), True, True, True);
    DelTree(ExpandConstant('{app}\tools'), True, True, True);
  end;
end;
