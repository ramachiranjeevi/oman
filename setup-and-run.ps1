# Fully automated setup + run for a fresh checkout of this repo, on Windows.
#
# Downloads the pinned Node 22 / JDK 17 runtimes and Camunda Platform Run
# into .tools/ if they aren't already there, installs JS dependencies,
# creates .env files with dev-only defaults if they don't already exist,
# restores the Directus schema snapshot, then starts all three modules.
#
# Safe to re-run: every step is skipped if its result already exists, so
# this won't clobber a working setup or redownload anything twice.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$Root = $PSScriptRoot
$ToolsDir = Join-Path $Root '.tools'
New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

# The console window this runs in (especially when the .bat is
# double-clicked rather than run from an already-open terminal) closes the
# instant this script exits, whether it succeeded or crashed -- so without
# a transcript + a guaranteed pause at the end, a failure is invisible.
# Both are unconditional (see the try/finally wrapping everything below).
$TranscriptPath = Join-Path $Root 'setup-and-run.log'
try { Start-Transcript -Path $TranscriptPath -Append | Out-Null } catch {}

$NodeVersion = '22.22.0'
$NodeDir = Join-Path $ToolsDir "node-v$NodeVersion-win-x64"
$CamundaVersion = '7.22.0'

function Log($msg)  { Write-Host "`n== $msg ==" }
function Warn($msg) { Write-Host "!! $msg" -ForegroundColor Yellow }

try {

# ---------------------------------------------------------------- 1. Node
Log '[1/9] Node' $NodeVersion
if (Test-Path (Join-Path $NodeDir 'node.exe')) {
  Write-Host 'already present, skipping download.'
} else {
  Write-Host 'downloading from nodejs.org...'
  $zip = Join-Path $ToolsDir 'node22.zip'
  try {
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $ToolsDir -Force
    Remove-Item $zip
  } catch {
    Write-Host "FATAL: could not download Node $NodeVersion. Install it yourself and re-run." -ForegroundColor Red
    exit 1
  }
}
$env:PATH = "$NodeDir;$env:PATH"

# OneDrive (and similar sync clients) often leaves node_modules files that
# exist on disk but cannot be read (EPERM / Access denied). Keep pnpm's
# content-addressable store off the synced drive, and if Directus's
# node_modules is a normal folder of locked files, move it aside so pnpm
# can create a fresh one.
$PnpmLocal = Join-Path $env:LOCALAPPDATA 'oman-app'
New-Item -ItemType Directory -Force -Path $PnpmLocal | Out-Null
$env:npm_config_store_dir = Join-Path $PnpmLocal 'pnpm-store'

function Ensure-WritableNodeModules($projectDir) {
  $nm = Join-Path $projectDir 'node_modules'
  if (-not (Test-Path $nm)) { return }
  $probe = Get-ChildItem -Path $nm -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.js', '.mjs', '.cjs' } |
    Select-Object -First 8
  $unreadable = $false
  foreach ($f in $probe) {
    try { [void][System.IO.File]::ReadAllBytes($f.FullName) } catch { $unreadable = $true; break }
  }
  if (-not $unreadable) { return }
  $bak = "$nm.onedrive-locked"
  if (Test-Path $bak) { $bak = "$nm.onedrive-locked-$(Get-Random)" }
  Warn "node_modules files under $projectDir are unreadable (common on OneDrive)."
  Warn "Moving it to $bak so pnpm can install a fresh copy. Delete the backup later to reclaim disk."
  Rename-Item $nm $bak
}

# ------------------------------------------------------------- 2. JDK 17
Log '[2/9] JDK 17 (Temurin)'
$JdkDir = Get-ChildItem -Path $ToolsDir -Directory -Filter 'jdk-17*' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
if ($JdkDir -and (Test-Path (Join-Path $JdkDir 'bin\java.exe'))) {
  Write-Host "already present at $JdkDir, skipping download."
} else {
  Write-Host 'downloading Temurin 17.0.13+11 from Adoptium...'
  $zip = Join-Path $ToolsDir 'jdk17.zip'
  $jdkUrl = 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.13%2B11/OpenJDK17U-jdk_x64_windows_hotspot_17.0.13_11.zip'
  try {
    Invoke-WebRequest -Uri $jdkUrl -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $ToolsDir -Force
    Remove-Item $zip
    $JdkDir = Get-ChildItem -Path $ToolsDir -Directory -Filter 'jdk-17*' | Select-Object -First 1 -ExpandProperty FullName
  } catch {
    Warn "Could not download JDK 17 automatically (Adoptium's exact release URLs can change)."
    Warn "Download manually from https://adoptium.net/temurin/releases/?version=17 (Windows x64, JDK, zip)"
    Warn "and extract into $ToolsDir -- Camunda will be skipped for now."
    $JdkDir = $null
  }
}

# ------------------------------------------------- 3. Camunda Platform Run
Log "[3/9] Camunda Platform Run $CamundaVersion"
$camundaInternal = Join-Path $Root 'camunda-module\internal'
if (Test-Path $camundaInternal) {
  Write-Host 'already present, skipping download.'
} else {
  Write-Host "downloading Camunda Platform Run $CamundaVersion..."
  $zip = Join-Path $ToolsDir 'camunda-run.zip'
  $extractDir = Join-Path $ToolsDir 'camunda-run-extract'
  try {
    Invoke-WebRequest -Uri "https://downloads.camunda.cloud/release/camunda-bpm/run/7.22/camunda-bpm-run-$CamundaVersion.zip" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $extractDir -Force
    Remove-Item $zip
    Copy-Item -Path (Join-Path $extractDir 'internal') -Destination $camundaInternal -Recurse
    Remove-Item $extractDir -Recurse -Force
  } catch {
    Warn "Could not download Camunda Platform Run automatically (this URL is best-effort, not guaranteed stable)."
    Warn "Download manually from https://camunda.com/download/camunda-platform-7/ (select 'Camunda Run'),"
    Warn "extract it, and copy its internal folder into $camundaInternal -- Camunda will be skipped for now."
  }
}

# ------------------------------------------------ 4. Install dependencies
Log '[4/9] Installing dependencies'
try {
  corepack enable
} catch {
  Warn "corepack enable failed ($($_.Exception.Message)) -- if this machine's global npm is installed"
  Warn "under Program Files, this usually means it needs an elevated (Run as Administrator) shell."
  Warn "Continuing anyway; pnpm/npm install below will fail loudly if this actually matters."
}
Ensure-WritableNodeModules (Join-Path $Root 'directus')
Push-Location (Join-Path $Root 'directus')
pnpm install
if ($LASTEXITCODE -ne 0) { Write-Host 'FATAL: pnpm install failed in directus/' -ForegroundColor Red; Pop-Location; exit 1 }
# Workspace packages export from dist/ (e.g. @directus/env). pnpm install
# does not compile them, so `pnpm run dev` fails with ERR_MODULE_NOT_FOUND
# until this runs once.
if (Test-Path (Join-Path $Root 'directus\packages\env\dist\index.js')) {
  Write-Host 'Directus workspace packages already built, skipping.'
} else {
  Write-Host 'building Directus workspace packages (first run; this can take several minutes)...'
  pnpm --filter @directus/api... build
  if ($LASTEXITCODE -ne 0) { Write-Host 'FATAL: pnpm build failed in directus/' -ForegroundColor Red; Pop-Location; exit 1 }
}
Pop-Location
Push-Location (Join-Path $Root 'platform')
npm install
if ($LASTEXITCODE -ne 0) { Write-Host 'FATAL: npm install failed in platform/' -ForegroundColor Red; Pop-Location; exit 1 }
Pop-Location

# ------------------------------------------------------- 5. .env files
Log '[5/9] Environment files'
$DevPassword = 'ChangeMe123!'   # dev-only default -- change for anything beyond local testing

$directusEnv = Join-Path $Root 'directus\api\.env'
if (Test-Path $directusEnv) {
  Write-Host 'directus/api/.env already exists, leaving it untouched.'
} else {
  Write-Host 'creating directus/api/.env with generated secrets + dev-default admin password...'
  $key = [guid]::NewGuid().ToString()
  $secret = [guid]::NewGuid().ToString()
  (Get-Content (Join-Path $Root 'directus\api\.env.example')) |
    ForEach-Object {
      $_ -replace '^KEY=.*', "KEY=$key" `
         -replace '^SECRET=.*', "SECRET=$secret" `
         -replace '^ADMIN_PASSWORD=.*', "ADMIN_PASSWORD=$DevPassword"
    } | Set-Content $directusEnv
}

$platformEnv = Join-Path $Root 'platform\.env'
if (Test-Path $platformEnv) {
  Write-Host 'platform/.env already exists, leaving it untouched.'
} else {
  Write-Host 'creating platform/.env with generated secret + matching dev password...'
  $sessionSecret = [guid]::NewGuid().ToString() + [guid]::NewGuid().ToString()
  (Get-Content (Join-Path $Root 'platform\.env.example')) |
    ForEach-Object {
      $_ -replace '^SESSION_SECRET=.*', "SESSION_SECRET=$sessionSecret" `
         -replace '^DIRECTUS_SERVICE_PASSWORD=.*', "DIRECTUS_SERVICE_PASSWORD=$DevPassword"
    } | Set-Content $platformEnv
}

# $path defaults to / — for Directus use /server/ping, because / redirects
# to /admin which 404s when SERVE_APP=false (API-only mode).
# Use 127.0.0.1 not localhost: on Windows localhost often resolves to ::1
# first, while Directus binds IPv4 only (0.0.0.0), so health checks hang.
function Wait-ForPort($port, $name, $path = '/') {
  Write-Host -NoNewline "waiting for $name on port $port"
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:${port}${path}" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
      Write-Host ' up.'
      return $true
    } catch {
      Write-Host -NoNewline '.'
      Start-Sleep -Seconds 2
    }
  }
  Write-Host ' -- timed out.'
  return $false
}

# -------------------------------------------------------- 5b. Postgres
Log '[6/9] Postgres (Directus + Camunda databases)'
& (Join-Path $Root 'ops\ensure-postgres.ps1') -Root $Root
if ($LASTEXITCODE -ne 0) {
  Write-Host 'FATAL: Postgres is required. See messages above.' -ForegroundColor Red
  exit 1
}

# --------------------------------------------------- 7. Start Directus
Log '[7/9] Starting Directus'
# Fresh DB has no Directus system tables; `pnpm run dev` exits if they
# are missing. bootstrap is idempotent once the schema is initialized.
Push-Location (Join-Path $Root 'directus\api')
pnpm cli bootstrap
if ($LASTEXITCODE -ne 0) { Write-Host 'FATAL: Directus bootstrap failed' -ForegroundColor Red; Pop-Location; exit 1 }
Pop-Location
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "run-with-node22.bat > `"$Root\directus-dev.log`" 2>&1" `
  -WorkingDirectory (Join-Path $Root 'directus\api') -WindowStyle Minimized
if (-not (Wait-ForPort 8055 'Directus' '/server/ping')) { Warn "check $Root\directus-dev.log" }

# --------------------------------- 8. Restore schema, start Camunda
Log '[8/9] Restoring Directus schema + starting Camunda'
$emailMatch = Select-String -Path $directusEnv -Pattern '^ADMIN_EMAIL=(.*)$'
$passwordMatch = Select-String -Path $directusEnv -Pattern '^ADMIN_PASSWORD=(.*)$'
if (-not $emailMatch -or -not $passwordMatch) {
  Warn "Could not read ADMIN_EMAIL/ADMIN_PASSWORD from $directusEnv -- skipping schema restore."
  Warn 'Once fixed, run manually: node ops/promote-directus-schema.mjs directus/schema/directus-schema.json'
} else {
  $env:DIRECTUS_URL = 'http://localhost:8055'
  $env:DIRECTUS_ADMIN_EMAIL = $emailMatch.Matches[0].Groups[1].Value
  $env:DIRECTUS_ADMIN_PASSWORD = $passwordMatch.Matches[0].Groups[1].Value
  node (Join-Path $Root 'ops\promote-directus-schema.mjs') (Join-Path $Root 'directus\schema\directus-schema.json')
  if ($LASTEXITCODE -ne 0) {
    Warn 'Schema promotion failed -- confirm Directus is up, then re-run: node ops/promote-directus-schema.mjs directus/schema/directus-schema.json'
  }
  node (Join-Path $Root 'ops\seed-directus-portal-users.mjs')
  if ($LASTEXITCODE -ne 0) {
    Warn 'Portal user seed failed -- re-run: node ops/seed-directus-portal-users.mjs'
  }
}

if ($JdkDir -and (Test-Path $camundaInternal)) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "run-with-jdk17.bat > `"$Root\camunda-boot.log`" 2>&1" `
    -WorkingDirectory (Join-Path $Root 'camunda-module') -WindowStyle Minimized
  if (-not (Wait-ForPort 8080 'Camunda')) { Warn "check $Root\camunda-boot.log" }
} else {
  Warn 'Skipping Camunda start -- JDK or Camunda binary is missing (see warnings above).'
}

# --------------------------------------------------- 9. Start Platform
Log '[9/9] Starting Platform'
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "npm run dev > `"$Root\platform-dev.log`" 2>&1" `
  -WorkingDirectory (Join-Path $Root 'platform') -WindowStyle Minimized
if (-not (Wait-ForPort 4000 'Platform')) { Warn "check $Root\platform-dev.log" }

Write-Host "`n============================================"
Write-Host ' Open http://localhost:4000'
Write-Host ' Demo logins: applicant/applicant123, specialist/specialist123, head/head123, admin/admin123'
Write-Host '============================================'

} catch {
  Write-Host "`nFATAL ERROR: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host $_.ScriptStackTrace -ForegroundColor Red
  Write-Host "`nFull details were also written to $TranscriptPath" -ForegroundColor Yellow
} finally {
  try { Stop-Transcript | Out-Null } catch {}
  Write-Host "`n(Log saved to $TranscriptPath)"
  Read-Host 'Press Enter to close this window'
}
