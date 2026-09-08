# Ensures local Postgres is reachable for Directus + Camunda, and that the
# Camunda JDBC driver is present. Prefers Docker Compose; falls back to an
# already-running Postgres on localhost:5432.
#
# Dev credentials (must match docker-compose.yml / Directus .env / Camunda yml):
#   user=oman password=oman_dev
#   databases: oman_directus, oman_camunda

param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "== $msg ==" }
function Write-Warn($msg) { Write-Host "!! $msg" -ForegroundColor Yellow }

$Userlib = Join-Path $Root 'camunda-module\configuration\userlib'
$JdbcJar = Join-Path $Userlib 'postgresql-42.7.5.jar'
$JdbcUrl = 'https://repo1.maven.org/maven2/org/postgresql/postgresql/42.7.5/postgresql-42.7.5.jar'

New-Item -ItemType Directory -Force -Path $Userlib | Out-Null
if (-not (Test-Path $JdbcJar)) {
  Write-Step "Downloading Postgres JDBC driver"
  Invoke-WebRequest -Uri $JdbcUrl -OutFile $JdbcJar
} else {
  Write-Host "Postgres JDBC already present."
}

function Test-PostgresPort {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect('127.0.0.1', 5432, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(1500, $false)
    if (-not $ok) { $client.Close(); return $false }
    $client.EndConnect($iar)
    $client.Close()
    return $true
  } catch {
    return $false
  }
}

if (-not (Test-PostgresPort)) {
  $docker = Get-Command docker -ErrorAction SilentlyContinue
  if ($docker) {
    Write-Step "Starting Postgres via docker compose"
    Push-Location $Root
    docker compose up -d postgres
    Pop-Location
  } else {
    Write-Warn "Postgres is not listening on localhost:5432 and Docker was not found."
    Write-Warn "Install Docker Desktop and run: docker compose up -d postgres"
    Write-Warn "Or install PostgreSQL 17 locally, create role/databases:"
    Write-Warn "  CREATE USER oman WITH PASSWORD 'oman_dev';"
    Write-Warn "  CREATE DATABASE oman_directus OWNER oman;"
    Write-Warn "  CREATE DATABASE oman_camunda OWNER oman;"
    exit 1
  }
}

Write-Host -NoNewline "waiting for Postgres on port 5432"
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  if (Test-PostgresPort) { $ready = $true; break }
  Write-Host -NoNewline '.'
  Start-Sleep -Seconds 2
}
if (-not $ready) {
  Write-Host ' -- timed out.'
  Write-Warn "Postgres did not become ready. Check: docker compose logs postgres"
  exit 1
}
Write-Host ' up.'

# If docker init already created DBs we're done. If using a bare Postgres
# install, try to create them when psql is on PATH.
$psql = Get-Command psql -ErrorAction SilentlyContinue
if ($psql) {
  $env:PGPASSWORD = 'oman_dev'
  foreach ($db in @('oman_directus', 'oman_camunda')) {
    $exists = & psql -h localhost -U oman -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" 2>$null
    if ($exists -ne '1') {
      Write-Host "creating database $db..."
      & psql -h localhost -U oman -d postgres -c "CREATE DATABASE $db OWNER oman;" | Out-Null
    }
  }
}

Write-Host "Postgres ready (oman_directus + oman_camunda expected)."
exit 0
