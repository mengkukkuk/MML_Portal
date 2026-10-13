; MMLPortal offline installer  -  Inno Setup script.
;
; Produced by installer\scripts\build.ps1, which assembles installer\staging\ and
; installer\redist\ (both gitignored  -  see installer\.gitignore) and then invokes ISCC.exe
; against this file. Do not run ISCC.exe directly without running build.ps1 first: staging\
; and redist\ won't exist.
;
; Bundled: a self-contained Python (embeddable + backend deps pre-installed), the built
; frontend, nssm.exe, and the URL-Rewrite/ARR redistributables. No internet access is required
; at install time.
;
; Two variants (selected by build.ps1):
;   Lite (default)  - PostgreSQL is NOT bundled (it is ~94% of the full installer). On a PC
;                     without PostgreSQL 18, place postgresql-18-windows-x64.exe next to this
;                     setup.exe; a PC that already runs PostgreSQL 18 needs nothing extra.
;   Full (/DBundlePostgres) - the EDB PostgreSQL installer is embedded too (single ~400 MB file).

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

#ifdef BundlePostgres
  #define PgSuffix "-Full"
#else
  #define PgSuffix ""
#endif

#define MyAppName "MMLPortal"
#define MyAppPublisher "MMLPortal"

[Setup]
AppId={{6F4E2C6A-6B1E-4B3E-9C7D-3F6E7C6E9A11}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName=C:\MMLPortal
; Always ask for the install path. Inno's default (auto) silently skips this page whenever a
; previous MMLPortal install exists, so an upgrade could never be pointed at another folder.
; The page is pre-filled with the previous path (UsePreviousAppDir defaults to yes), and a move
; carries backend\.env over -- see CurStepChanged.
DisableDirPage=no
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=Output
OutputBaseFilename=MMLPortalSetup-{#MyAppVersion}{#PgSuffix}
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
#ifdef BundlePostgres
Source: "redist\postgresql-18-windows-x64.exe"; DestDir: "{app}\redist"; Flags: ignoreversion
#endif
Source: "redist\rewrite_amd64_en-US.msi";       DestDir: "{app}\redist"; Flags: ignoreversion
Source: "redist\requestRouter_amd64.msi";       DestDir: "{app}\redist"; Flags: ignoreversion
Source: "scripts\postinstall.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "scripts\uninstall.ps1";   DestDir: "{app}\scripts"; Flags: ignoreversion

[Run]
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\postinstall.ps1"" -InstallDir ""{app}"" {code:GetHostnameArg} -Port {code:GetPort} -InstallPostgres {code:GetInstallPostgres} -EnableHttps {code:GetEnableHttps} -HttpsPort {code:GetHttpsPort} -AppDbName ""{code:GetAppDbName}"" -AppDbSchema ""{code:GetAppDbSchema}"" -PgInstallerPath ""{code:GetPgInstallerPath}"""; \
    StatusMsg: "Configuring PostgreSQL, IIS, and the MMLPortal service  -  this can take several minutes..."; \
    Flags: waituntilterminated

[UninstallRun]
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\uninstall.ps1"" -InstallDir ""{app}"""; \
    Flags: waituntilterminated runhidden; RunOnceId: "MMLPortalUninstall"

[Code]
var
  { Page 1: how operators reach the site (hostname, HTTP port, HTTPS). }
  NetworkPage: TInputQueryWizardPage;
  UseHostnameCheck: TNewCheckBox;
  HttpsCheck: TNewCheckBox;
  { Page 2: the database (bundled PostgreSQL, database name, schema). }
  DatabasePage: TInputQueryWizardPage;
  InstallPostgresCheck: TNewCheckBox;

const
  { Edit indexes on NetworkPage and DatabasePage. }
  NET_HOSTNAME = 0;
  NET_PORT = 1;
  NET_HTTPS_PORT = 2;
  DB_NAME = 0;
  DB_SCHEMA = 1;

{ Install path of the previous MMLPortal install, or '' on a first install. Read from Inno's
  own uninstall entry for this AppId (64-bit view, since the app installs in 64-bit mode). }
function PreviousAppDir(): string;
begin
  Result := '';
  RegQueryStringValue(HKLM64,
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#StringChange(SetupSetting("AppId"), "{{", "{")}_is1',
    'Inno Setup: App Path', Result);
  Result := RemoveBackslashUnlessRoot(Result);
end;

{ True when an existing install is being re-pointed at a different folder. }
function IsMovingInstall(): Boolean;
var
  Prev: string;
begin
  Prev := PreviousAppDir();
  Result := (Prev <> '') and
    (CompareText(Prev, RemoveBackslashUnlessRoot(WizardDirValue())) <> 0);
end;

function DetectExistingPostgres(): Boolean;
begin
  { The EDB installer registers its service under this key; presence here means a Postgres
    18 service already exists on this machine, so the checkbox should default to unchecked. }
  Result := RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\postgresql-x64-18');
end;

{ An input-query page has no checkbox of its own. Add one where prompt `Index` sits and push
  that prompt and every field below it (up to `Count` fields on the page) down to make room. }
function InsertCheckBox(Page: TInputQueryWizardPage; Index, Count: Integer;
  const Caption: string): TNewCheckBox;
var
  Shift, i: Integer;
begin
  Result := TNewCheckBox.Create(Page);
  Result.Parent := Page.Surface;
  Result.Caption := Caption;
  Result.Left := Page.PromptLabels[Index].Left;
  Result.Top := Page.PromptLabels[Index].Top;
  Result.Width := Page.SurfaceWidth;
  Result.Height := ScaleY(17);
  Shift := Result.Height + ScaleY(6);
  for i := Index to Count - 1 do
  begin
    Page.PromptLabels[i].Top := Page.PromptLabels[i].Top + Shift;
    Page.Edits[i].Top := Page.Edits[i].Top + Shift;
  end;
end;

procedure SetFieldEnabled(Page: TInputQueryWizardPage; Index: Integer; Enabled: Boolean);
begin
  Page.PromptLabels[Index].Enabled := Enabled;
  Page.Edits[Index].Enabled := Enabled;
end;

procedure NetworkChecksClick(Sender: TObject);
begin
  SetFieldEnabled(NetworkPage, NET_HOSTNAME, UseHostnameCheck.Checked);
  SetFieldEnabled(NetworkPage, NET_HTTPS_PORT, HttpsCheck.Checked);
end;

procedure InitializeWizard();
begin
  NetworkPage := CreateInputQueryPage(wpSelectDir,
    'Network and security', 'How will operators reach MMLPortal on this network?',
    'Without a hostname the site answers on any name or IP of this server. With one, other ' +
    'LAN PCs need a hosts-file or DNS entry for it. HTTPS uses a self-signed certificate ' +
    '(exported to the install folder''s certs\ for client PCs to trust).');
  NetworkPage.Add('Local hostname (e.g. mmlportal.local):', False);
  NetworkPage.Add('HTTP port:', False);
  NetworkPage.Add('HTTPS port:', False);
  NetworkPage.Values[NET_HOSTNAME] := 'mmlportal.local';
  NetworkPage.Values[NET_PORT] := '80';
  NetworkPage.Values[NET_HTTPS_PORT] := '443';

  UseHostnameCheck := InsertCheckBox(NetworkPage, NET_HOSTNAME, 3,
    'Use a local hostname (IIS host header)');
  UseHostnameCheck.Checked := False;
  UseHostnameCheck.OnClick := @NetworkChecksClick;

  { Recommended: without it, login credentials and session cookies cross the network in
    plain text. }
  HttpsCheck := InsertCheckBox(NetworkPage, NET_HTTPS_PORT, 3,
    'Enable HTTPS with a self-signed certificate (recommended)');
  HttpsCheck.Checked := True;
  HttpsCheck.OnClick := @NetworkChecksClick;
  NetworkChecksClick(nil);

  DatabasePage := CreateInputQueryPage(NetworkPage.ID,
    'Database', 'PostgreSQL 18 stores MMLPortal''s configuration and data.',
#ifdef BundlePostgres
    'Leave the install option checked on a blank PC; it is unchecked for you when ' +
    'PostgreSQL 18 is already installed. Keep the default database and schema unless your ' +
    'DBA provisioned one (letters, digits and underscores only).');
#else
    'Leave the install option checked on a blank PC and put postgresql-18-windows-x64.exe ' +
    'next to this setup program; it is unchecked for you when PostgreSQL 18 is already ' +
    'installed. Keep the default database and schema unless your DBA provisioned one.');
#endif
  DatabasePage.Add('Database name:', False);
  DatabasePage.Add('Schema:', False);
  DatabasePage.Values[DB_NAME] := 'postgres';
  DatabasePage.Values[DB_SCHEMA] := 'public';

  InstallPostgresCheck := InsertCheckBox(DatabasePage, DB_NAME, 2,
#ifdef BundlePostgres
    'Install bundled PostgreSQL 18 silently');
#else
    'Install PostgreSQL 18 silently (postgresql-18-windows-x64.exe next to setup)');
#endif
  InstallPostgresCheck.Checked := not DetectExistingPostgres();
end;

function IsValidPort(const Value: string): Boolean;
begin
  Result := (StrToIntDef(Trim(Value), -1) >= 1) and (StrToIntDef(Trim(Value), -1) <= 65535);
end;

function IsValidDbIdentifier(const Value: string): Boolean;
var
  i: Integer;
  c: Char;
begin
  Result := False;
  if (Length(Value) = 0) or (Length(Value) > 63) then
    Exit;
  c := Value[1];
  if not ((c = '_') or ((c >= 'A') and (c <= 'Z')) or ((c >= 'a') and (c <= 'z'))) then
    Exit;
  for i := 2 to Length(Value) do
  begin
    c := Value[i];
    if not ((c = '_') or ((c >= 'A') and (c <= 'Z')) or ((c >= 'a') and (c <= 'z')) or
            ((c >= '0') and (c <= '9'))) then
      Exit;
  end;
  Result := True;
end;

function GetPgInstallerPath(Param: string): string;
begin
#ifdef BundlePostgres
  Result := ExpandConstant('{app}\redist\postgresql-18-windows-x64.exe');
#else
  // The src constant is the folder setup.exe was launched from.
  Result := ExpandConstant('{src}\postgresql-18-windows-x64.exe');
#endif
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = wpSelectDir) and IsMovingInstall() then
  begin
    { The service and IIS site are rebuilt from the new folder by postinstall.ps1, and the
      settings file is copied across below, but the old folder itself is left in place. }
    Result := MsgBox('MMLPortal is currently installed in:' + #13#10 + '    ' + PreviousAppDir() + #13#10#13#10 +
      'Setup will move it to:' + #13#10 + '    ' + WizardDirValue() + #13#10#13#10 +
      'Your settings (backend\.env: database password and login secret) are copied to the new ' +
      'folder. The old folder is left in place; delete it once the new install is working.' + #13#10#13#10 +
      'Move the installation?', mbConfirmation, MB_YESNO) = IDYES;
  end
  else if CurPageID = NetworkPage.ID then
  begin
    if UseHostnameCheck.Checked and (Trim(NetworkPage.Values[NET_HOSTNAME]) = '') then
    begin
      MsgBox('Please enter a local hostname, or uncheck "Use a local hostname".', mbError, MB_OK);
      Result := False;
    end
    else if not IsValidPort(NetworkPage.Values[NET_PORT]) then
    begin
      MsgBox('Please enter a valid HTTP port number (1-65535).', mbError, MB_OK);
      Result := False;
    end
    else if HttpsCheck.Checked and not IsValidPort(NetworkPage.Values[NET_HTTPS_PORT]) then
    begin
      MsgBox('Please enter a valid HTTPS port number (1-65535).', mbError, MB_OK);
      Result := False;
    end
    else if HttpsCheck.Checked and
            (StrToInt(Trim(NetworkPage.Values[NET_PORT])) =
             StrToInt(Trim(NetworkPage.Values[NET_HTTPS_PORT]))) then
    begin
      MsgBox('The HTTP and HTTPS ports must be different.', mbError, MB_OK);
      Result := False;
    end;
  end
  else if CurPageID = DatabasePage.ID then
  begin
#ifndef BundlePostgres
    if InstallPostgresCheck.Checked and (not FileExists(GetPgInstallerPath(''))) then
    begin
      MsgBox('postgresql-18-windows-x64.exe was not found next to this setup program:' + #13#10 +
             GetPgInstallerPath('') + #13#10#13#10 +
             'Copy it into the same folder as the setup program, or uncheck this option if ' +
             'PostgreSQL 18 is already installed on this PC.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
#endif
    if not IsValidDbIdentifier(Trim(DatabasePage.Values[DB_NAME])) then
    begin
      MsgBox('Please enter a valid database name (letters, digits, underscores only; must not ' +
             'start with a digit; max 63 characters).', mbError, MB_OK);
      Result := False;
    end
    else if not IsValidDbIdentifier(Trim(DatabasePage.Values[DB_SCHEMA])) then
    begin
      MsgBox('Please enter a valid schema name (letters, digits, underscores only; must not ' +
             'start with a digit; max 63 characters).', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function GetHostname(Param: string): string;
begin
  if UseHostnameCheck.Checked then
    Result := Trim(NetworkPage.Values[NET_HOSTNAME])
  else
    Result := '';
end;

{ The whole -Hostname argument, or nothing. Windows PowerShell's -File mode does not
  reliably pass an empty quoted argument through, so a blank hostname is omitted rather
  than sent as -Hostname "". postinstall.ps1 treats a missing hostname as "no host header". }
function GetHostnameArg(Param: string): string;
begin
  if GetHostname('') = '' then
    Result := ''
  else
    Result := '-Hostname "' + GetHostname('') + '"';
end;

function GetPort(Param: string): string;
begin
  Result := Trim(NetworkPage.Values[NET_PORT]);
end;

function GetInstallPostgres(Param: string): string;
begin
  if InstallPostgresCheck.Checked then
    Result := 'true'
  else
    Result := 'false';
end;

function GetAppDbName(Param: string): string;
begin
  Result := Trim(DatabasePage.Values[DB_NAME]);
end;

function GetAppDbSchema(Param: string): string;
begin
  Result := Trim(DatabasePage.Values[DB_SCHEMA]);
end;

function GetEnableHttps(Param: string): string;
begin
  if HttpsCheck.Checked then
    Result := 'true'
  else
    Result := 'false';
end;

function GetHttpsPort(Param: string): string;
begin
  if HttpsCheck.Checked then
    Result := Trim(NetworkPage.Values[NET_HTTPS_PORT])
  else
    Result := '443';
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

    { Moving an existing install to a new folder: bring backend\.env along. It holds the
      generated database password and JWT secret (DPAPI machine-scoped, so still readable
      here); without it postinstall.ps1 would fall back to the default DB password and every
      connection to the existing PostgreSQL would fail. Never overwrite a .env already there. }
    if IsMovingInstall() and FileExists(PreviousAppDir() + '\backend\.env') and
       not FileExists(ExpandConstant('{app}\backend\.env')) then
    begin
      ForceDirectories(ExpandConstant('{app}\backend'));
      if not FileCopy(PreviousAppDir() + '\backend\.env', ExpandConstant('{app}\backend\.env'), True) then
        MsgBox('Could not copy settings from ' + PreviousAppDir() + '\backend\.env.' + #13#10 +
          'Copy that file into ' + ExpandConstant('{app}\backend') + ' by hand before starting MMLPortal.',
          mbError, MB_OK);
    end;
  end;
end;
