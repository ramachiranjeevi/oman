#!/usr/bin/env bash
# Ensures local Postgres is reachable for Directus + Camunda, and that the
# Camunda JDBC driver is present. Prefers Docker Compose; falls back to an
# already-running Postgres on localhost:5432.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USERLIB="$ROOT/camunda-module/configuration/userlib"
JAR="$USERLIB/postgresql-42.7.5.jar"
JAR_URL="https://repo1.maven.org/maven2/org/postgresql/postgresql/42.7.5/postgresql-42.7.5.jar"

mkdir -p "$USERLIB"
if [ ! -f "$JAR" ]; then
  echo "== Downloading Postgres JDBC driver =="
  curl -fL -o "$JAR" "$JAR_URL"
else
  echo "Postgres JDBC already present."
fi

pg_up() { (echo > /dev/tcp/127.0.0.1/5432) >/dev/null 2>&1; }

docker_compose() {
  if docker info >/dev/null 2>&1; then
    if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi
  elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    if sudo docker compose version >/dev/null 2>&1; then sudo docker compose "$@"; else sudo docker-compose "$@"; fi
  else
    echo "!! Docker is installed but this user cannot access the daemon."
    echo "!! Run with sudo, or add the user to the docker group and sign in again."
    return 1
  fi
}

if ! pg_up; then
  if command -v docker >/dev/null 2>&1; then
    echo "== Starting Postgres via docker compose =="
    ( cd "$ROOT" && docker_compose up -d postgres )
  else
    echo "!! Postgres is not listening on localhost:5432 and Docker was not found."
    echo "!! Install Docker and run: docker compose up -d postgres"
    echo "!! Or install PostgreSQL and create oman / oman_directus / oman_camunda."
    exit 1
  fi
fi

echo -n "waiting for Postgres on port 5432"
for i in $(seq 1 60); do
  if pg_up; then echo " up."; break; fi
  echo -n "."
  sleep 2
  if [ "$i" -eq 60 ]; then
    echo " — timed out."
    exit 1
  fi
done

if command -v psql >/dev/null 2>&1; then
  export PGPASSWORD=oman_dev
  for db in oman_directus oman_camunda; do
    exists="$(psql -h localhost -U oman -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" 2>/dev/null || true)"
    if [ "$exists" != "1" ]; then
      echo "creating database $db..."
      psql -h localhost -U oman -d postgres -c "CREATE DATABASE $db OWNER oman;" >/dev/null
    fi
  done
fi

echo "Postgres ready (oman_directus + oman_camunda expected)."
