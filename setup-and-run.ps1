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

$NodeVersion = '22.22.0'
$NodeDir = Join-Path $ToolsDir "node-v$NodeVersion-win-x64"
$CamundaVersion = '7.22.0'

function Log($msg)  { Write-Host "`n== $msg ==" }
function Warn($msg) { Write-Host "!! $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 1. Node
Log '[1/8] Node' $NodeVersion
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

# ------------------------------------------------------------- 2. JDK 17
Log '[2/8] JDK 17 (Temurin)'
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
Log "[3/8] Camunda Platform Run $CamundaVersion"
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
Log '[4/8] Installing dependencies'
corepack enable 2>$null
Push-Location (Join-Path $Root 'directus')
pnpm install
if ($LASTEXITCODE -ne 0) { Write-Host 'FATAL: pnpm install failed in directus/' -ForegroundColor Red; Pop-Location; exit 1 }
Pop-Location
Push-Location (Join-Path $Root 'platform')
npm install
if ($LASTEXITCODE -ne 0) { Write-Host 'FATAL: npm install failed in platform/' -ForegroundColor Red; Pop-Location; exit 1 }
Pop-Location

# ------------------------------------------------------- 5. .env files
Log '[5/8] Environment files'
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

function Wait-ForPort($port, $name) {
  Write-Host -NoNewline "waiting for $name on port $port"
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $r = Invoke-WebRequest -Uri "http://localhost:$port" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
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

# --------------------------------------------------- 6. Start Directus
Log '[6/8] Starting Directus'
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "run-with-node22.bat > `"$Root\directus-dev.log`" 2>&1" `
  -WorkingDirectory (Join-Path $Root 'directus\api') -WindowStyle Minimized
if (-not (Wait-ForPort 8055 'Directus')) { Warn "check $Root\directus-dev.log" }

# --------------------------------- 7. Restore schema, start Camunda
Log '[7/8] Restoring Directus schema + starting Camunda'
$adminEmail = (Select-String -Path $directusEnv -Pattern '^ADMIN_EMAIL=(.*)$').Matches[0].Groups[1].Value
$adminPassword = (Select-String -Path $directusEnv -Pattern '^ADMIN_PASSWORD=(.*)$').Matches[0].Groups[1].Value
$env:DIRECTUS_URL = 'http://localhost:8055'
$env:DIRECTUS_ADMIN_EMAIL = $adminEmail
$env:DIRECTUS_ADMIN_PASSWORD = $adminPassword
node (Join-Path $Root 'ops\promote-directus-schema.mjs') (Join-Path $Root 'directus\schema\directus-schema.json')
if ($LASTEXITCODE -ne 0) {
  Warn 'Schema promotion failed -- confirm Directus is up, then re-run: node ops/promote-directus-schema.mjs directus/schema/directus-schema.json'
}

if ($JdkDir -and (Test-Path $camundaInternal)) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "run-with-jdk17.bat > `"$Root\camunda-boot.log`" 2>&1" `
    -WorkingDirectory (Join-Path $Root 'camunda-module') -WindowStyle Minimized
  if (-not (Wait-ForPort 8080 'Camunda')) { Warn "check $Root\camunda-boot.log" }
} else {
  Warn 'Skipping Camunda start -- JDK or Camunda binary is missing (see warnings above).'
}

# --------------------------------------------------- 8. Start Platform
Log '[8/8] Starting Platform'
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "npm run dev > `"$Root\platform-dev.log`" 2>&1" `
  -WorkingDirectory (Join-Path $Root 'platform') -WindowStyle Minimized
if (-not (Wait-ForPort 4000 'Platform')) { Warn "check $Root\platform-dev.log" }

Write-Host "`n============================================"
Write-Host ' Open http://localhost:4000'
Write-Host ' Demo logins: applicant/applicant123, specialist/specialist123, head/head123, admin/admin123'
Write-Host '============================================'
