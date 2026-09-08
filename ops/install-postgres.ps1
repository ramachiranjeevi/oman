#Requires -RunAsAdministrator
# Install PostgreSQL 17 for the Oman platform (local/dev).
# Double-click ops\install-postgres.bat (Run as administrator) if UAC blocks the agent.
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path $PSScriptRoot -Parent

$ToolsInstaller = Join-Path $RepoRoot '.tools\postgresql-17.11-3-windows-x64.exe'
$TempInstaller = Join-Path $env:TEMP 'postgresql-17.11-3-windows-x64.exe'
$InstallerUrl = 'https://get.enterprisedb.com/postgresql/postgresql-17.11-3-windows-x64.exe'
$Prefix = 'C:\Program Files\PostgreSQL\17'
$DataDir = 'C:\Program Files\PostgreSQL\17\data'
$Log = Join-Path $RepoRoot 'pgsql-install.log'
$SuperPassword = 'oman_dev'   # local/dev only — postgres superuser + app role password

function Log($m) {
  $line = "$(Get-Date -Format o)  $m"
  Write-Host $line
  Add-Content -Path $Log -Value $line
}

function Test-Installer($path) {
  return (Test-Path $path) -and ((Get-Item $path).Length -gt 100MB)
}

New-Item -ItemType Directory -Force -Path (Join-Path $RepoRoot '.tools') | Out-Null
'' | Set-Content $Log
Log 'PostgreSQL 17 install starting'

# Prefer the repo-local copy (survives admin vs user TEMP differences and
# avoids re-downloading when EnterpriseDB closes the connection).
$Installer = $null
foreach ($candidate in @(
  $ToolsInstaller,
  $TempInstaller,
  'C:\Users\40032242\AppData\Local\Temp\postgresql-17.11-3-windows-x64.exe'
)) {
  if (Test-Installer $candidate) {
    $Installer = $candidate
    Log "Using existing installer: $Installer ($([math]::Round((Get-Item $Installer).Length/1MB,1)) MB)"
    break
  }
}

if (-not $Installer) {
  $Installer = $ToolsInstaller
  Log "Downloading installer to $Installer (EnterpriseDB can be flaky — retry if it fails)"
  $headers = @{ 'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  try {
    # curl.exe resumes better than Invoke-WebRequest on flaky links
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
      & curl.exe -L --retry 5 --retry-all-errors -A $headers['User-Agent'] -o $Installer $InstallerUrl
      if ($LASTEXITCODE -ne 0 -or -not (Test-Installer $Installer)) {
        throw "curl download failed (exit $LASTEXITCODE)"
      }
    } else {
      Invoke-WebRequest -Uri $InstallerUrl -OutFile $Installer -Headers $headers
    }
  } catch {
    Log "Download failed: $($_.Exception.Message)"
    throw @"
Could not download the PostgreSQL installer.
Place the file manually at:
  $ToolsInstaller
Then re-run this script.
"@
  }
}

if ($Installer -ne $ToolsInstaller -and -not (Test-Installer $ToolsInstaller)) {
  Log "Copying installer into .tools for next run"
  Copy-Item $Installer $ToolsInstaller -Force
  $Installer = $ToolsInstaller
}

if (Test-Path "$Prefix\bin\psql.exe") {
  Log 'PostgreSQL 17 already installed — skipping installer.'
} else {
  $argList = @(
    '--mode', 'unattended',
    '--unattendedmodeui', 'minimal',
    '--superpassword', $SuperPassword,
    '--servicename', 'postgresql-x64-17',
    '--serverport', '5432',
    '--prefix', $Prefix,
    '--datadir', $DataDir,
    '--locale', 'English, United States',
    '--install_runtimes', '0'
  )
  Log "Running unattended installer from $Installer ..."
  $p = Start-Process -FilePath $Installer -ArgumentList $argList -Wait -PassThru
  Log "installer exit=$($p.ExitCode)"
  if ($p.ExitCode -ne 0) { throw "PostgreSQL installer failed with exit $($p.ExitCode)" }
}

$psql = Join-Path $Prefix 'bin\psql.exe'
if (-not (Test-Path $psql)) { throw "psql not found at $psql" }

$svc = Get-Service -Name 'postgresql-x64-17' -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Running') {
  Start-Service 'postgresql-x64-17'
  Start-Sleep 3
}

$env:PATH = "$(Join-Path $Prefix 'bin');$env:PATH"
$env:PGPASSWORD = $SuperPassword

Log 'Creating role/databases oman / oman_directus / oman_camunda (idempotent)'
& $psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -c @"
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'oman') THEN
    CREATE ROLE oman LOGIN PASSWORD '$SuperPassword';
  END IF;
END
`$`$;
SELECT 'role oman ok';
"@

foreach ($db in @('oman_directus', 'oman_camunda')) {
  $exists = & $psql -h localhost -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'"
  if ($exists -ne '1') {
    Log "Creating database $db"
    & $psql -h localhost -U postgres -d postgres -c "CREATE DATABASE $db OWNER oman;"
  } else {
    Log "Database $db already exists"
  }
}

Log 'Done. Postgres ready on localhost:5432'
Log '  user=oman  password=oman_dev  dbs=oman_directus,oman_camunda'
Write-Host ''
Write-Host 'SUCCESS — PostgreSQL is installed and databases are ready.' -ForegroundColor Green
