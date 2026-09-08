#!/usr/bin/env bash
# Fully automated setup + run for a fresh checkout of this repo, on Linux.
#
# Installs missing Ubuntu/Debian prerequisites when possible, downloads the
# pinned Node 22 / JDK 17 runtimes and Camunda Platform Run into .tools/,
# installs JS dependencies, creates .env files, restores the Directus schema,
# then starts all services. Intended for a fresh x86_64 Linux VM.
#
# Safe to re-run: every step is skipped if its result already exists, so
# this won't clobber a working setup or redownload anything twice.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"
TOOLS_DIR="$ROOT/.tools"
mkdir -p "$TOOLS_DIR"

NODE_VERSION="22.22.0"
NODE_DIR="$TOOLS_DIR/node-v${NODE_VERSION}-linux-x64"
CAMUNDA_VERSION="7.22.0"

log()  { echo -e "\n== $1 =="; }
warn() { echo "!! $1"; }
fatal() { echo "FATAL: $1" >&2; exit 1; }

# ---------------------------------------------------------- 0. VM prerequisites
log "[0/9] Linux VM prerequisites"
[ "$(uname -s)" = "Linux" ] || fatal "this script is for Linux; use the Windows launchers on Windows."
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fatal "the pinned Node/JDK downloads require an x86_64 VM (found $(uname -m))." ;;
esac

missing=()
for cmd in curl tar xz unzip openssl make g++ python3; do
  command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
done
command -v docker >/dev/null 2>&1 || missing+=("docker")
if command -v docker >/dev/null 2>&1 \
  && ! docker compose version >/dev/null 2>&1 \
  && ! command -v docker-compose >/dev/null 2>&1; then
  missing+=("docker-compose")
fi

if [ ${#missing[@]} -gt 0 ]; then
  echo "missing: ${missing[*]}"
  if command -v apt-get >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then SUDO=""; elif command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else fatal "sudo is required to install system packages."; fi
    echo "installing required Ubuntu/Debian packages..."
    $SUDO apt-get update
    $SUDO apt-get install -y ca-certificates curl tar xz-utils unzip openssl build-essential python3 docker.io
    $SUDO apt-get install -y docker-compose-v2 2>/dev/null \
      || $SUDO apt-get install -y docker-compose-plugin 2>/dev/null \
      || $SUDO apt-get install -y docker-compose
  else
    fatal "install curl, tar, xz, unzip, openssl, Docker and Docker Compose, then re-run."
  fi
fi

if command -v systemctl >/dev/null 2>&1; then
  if [ "$(id -u)" -eq 0 ]; then systemctl enable --now docker || true
  elif command -v sudo >/dev/null 2>&1; then sudo systemctl enable --now docker || true
  fi
fi

available_kb="$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')"
[ "${available_kb:-0}" -ge 8388608 ] || warn "Less than 8 GB free disk; the Directus source build may fail."
memory_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
[ "${memory_kb:-0}" -ge 3145728 ] || warn "Less than 3 GB RAM; add swap before building Directus."

# ---------------------------------------------------------------- 1. Node
log "[1/9] Node ${NODE_VERSION}"
if [ -x "$NODE_DIR/bin/node" ]; then
  echo "already present, skipping download."
else
  echo "downloading from nodejs.org..."
  if curl -fL -o "$TOOLS_DIR/node22.tar.xz" \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; then
    tar -xJf "$TOOLS_DIR/node22.tar.xz" -C "$TOOLS_DIR"
    rm -f "$TOOLS_DIR/node22.tar.xz"
  else
    echo "FATAL: could not download Node ${NODE_VERSION}. Install it yourself and re-run." >&2
    exit 1
  fi
fi
export PATH="$NODE_DIR/bin:$PATH"

# ------------------------------------------------------------- 2. JDK 17
log "[2/9] JDK 17 (Temurin)"
JDK_DIR="$(compgen -G "$TOOLS_DIR/jdk-17*" | head -n1 || true)"
if [ -n "$JDK_DIR" ] && [ -x "$JDK_DIR/bin/java" ]; then
  echo "already present at $JDK_DIR, skipping download."
else
  echo "downloading Temurin 17.0.13+11 from Adoptium..."
  JDK_URL="https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.13%2B11/OpenJDK17U-jdk_x64_linux_hotspot_17.0.13_11.tar.gz"
  if curl -fL -o "$TOOLS_DIR/jdk17.tar.gz" "$JDK_URL"; then
    tar -xzf "$TOOLS_DIR/jdk17.tar.gz" -C "$TOOLS_DIR"
    rm -f "$TOOLS_DIR/jdk17.tar.gz"
    JDK_DIR="$(compgen -G "$TOOLS_DIR/jdk-17*" | head -n1 || true)"
  else
    warn "Could not download JDK 17 automatically (Adoptium's exact release URLs can change)."
    warn "Download manually from https://adoptium.net/temurin/releases/?version=17 (Linux x64, JDK, tar.gz)"
    warn "and extract into $TOOLS_DIR — Camunda will be skipped for now."
    JDK_DIR=""
  fi
fi

# ------------------------------------------------- 3. Camunda Platform Run
log "[3/9] Camunda Platform Run ${CAMUNDA_VERSION}"
if [ -d "$ROOT/camunda-module/internal" ]; then
  echo "already present, skipping download."
else
  if ! command -v unzip >/dev/null 2>&1; then
    warn "'unzip' is not installed — install it (e.g. apt install unzip) and re-run to set up Camunda."
  else
    echo "downloading Camunda Platform Run ${CAMUNDA_VERSION}..."
    CAMUNDA_URL="https://downloads.camunda.cloud/release/camunda-bpm/run/7.22/camunda-bpm-run-${CAMUNDA_VERSION}.zip"
    if curl -fL -o "$TOOLS_DIR/camunda-run.zip" "$CAMUNDA_URL"; then
      TMP_EXTRACT="$TOOLS_DIR/camunda-run-extract"
      rm -rf "$TMP_EXTRACT"; mkdir -p "$TMP_EXTRACT"
      unzip -q "$TOOLS_DIR/camunda-run.zip" -d "$TMP_EXTRACT"
      rm -f "$TOOLS_DIR/camunda-run.zip"
      cp -r "$TMP_EXTRACT/internal" "$ROOT/camunda-module/internal"
      chmod +x "$ROOT/camunda-module/internal"/*.sh 2>/dev/null || true
      find "$ROOT/camunda-module/internal" -name "*.sh" -exec chmod +x {} \; 2>/dev/null || true
      rm -rf "$TMP_EXTRACT"
    else
      warn "Could not download Camunda Platform Run automatically (this URL is best-effort, not guaranteed stable)."
      warn "Download manually from https://camunda.com/download/camunda-platform-7/ (select 'Camunda Run'),"
      warn "extract it, and copy its internal/ folder into $ROOT/camunda-module/internal — Camunda will be skipped for now."
    fi
  fi
fi

# ------------------------------------------------ 4. Install dependencies
log "[4/9] Installing dependencies"
corepack enable 2>/dev/null || true
( cd "$ROOT/directus" && pnpm install --frozen-lockfile ) || { echo "FATAL: pnpm install failed in directus/" >&2; exit 1; }
# Workspace packages export from dist/ (e.g. @directus/env). pnpm install
# does not compile them, so `pnpm run dev` fails with ERR_MODULE_NOT_FOUND
# until this runs once.
if [ -f "$ROOT/directus/packages/env/dist/index.js" ]; then
  echo "Directus workspace packages already built, skipping."
else
  echo "building Directus workspace packages (first run; this can take several minutes)..."
  ( cd "$ROOT/directus" && pnpm --filter @directus/api... build ) || { echo "FATAL: pnpm build failed in directus/" >&2; exit 1; }
fi
( cd "$ROOT/platform" && npm ci ) || { echo "FATAL: npm ci failed in platform/" >&2; exit 1; }

# ------------------------------------------------------- 5. .env files
log "[5/9] Environment files"
DEV_PASSWORD="${OMAN_ADMIN_PASSWORD:-ChangeMe123!}" # override on a non-demo VM

gen_secret() { openssl rand -hex 32 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen; }

if [ -f "$ROOT/directus/api/.env" ]; then
  echo "directus/api/.env already exists, leaving it untouched."
else
  echo "creating directus/api/.env with generated secrets + dev-default admin password..."
  sed -e "s/^KEY=.*/KEY=$(gen_secret)/" \
      -e "s/^SECRET=.*/SECRET=$(gen_secret)/" \
      -e "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$DEV_PASSWORD/" \
      "$ROOT/directus/api/.env.example" > "$ROOT/directus/api/.env"
fi

if [ -f "$ROOT/platform/.env" ]; then
  echo "platform/.env already exists, leaving it untouched."
else
  echo "creating platform/.env with generated secret + matching dev password..."
  sed -e "s/^SESSION_SECRET=.*/SESSION_SECRET=$(gen_secret)/" \
      -e "s/^DIRECTUS_SERVICE_PASSWORD=.*/DIRECTUS_SERVICE_PASSWORD=$DEV_PASSWORD/" \
      "$ROOT/platform/.env.example" > "$ROOT/platform/.env"
fi

# Optional 3rd arg is a path (default /). Directus needs /server/ping because
# / redirects to /admin which 404s when SERVE_APP=false.
wait_for_port() {
  local port=$1 name=$2 path=${3:-/} tries=60
  echo -n "waiting for $name on port $port"
  while ! curl -sf "http://127.0.0.1:${port}${path}" -o /dev/null 2>/dev/null; do
    tries=$((tries - 1))
    [ $tries -le 0 ] && { echo " — timed out."; return 1; }
    echo -n "."; sleep 2
  done
  echo " up."
}

# -------------------------------------------------------- 6. Postgres
log "[6/9] Postgres (Directus + Camunda databases)"
bash "$ROOT/ops/ensure-postgres.sh" || { echo "FATAL: Postgres is required." >&2; exit 1; }

# --------------------------------------------------- 7. Start Directus
log "[7/9] Starting Directus"
# Fresh DB has no Directus system tables; `pnpm run dev` exits if they
# are missing. bootstrap is idempotent once the schema is initialized.
if curl -sf http://127.0.0.1:8055/server/ping -o /dev/null 2>/dev/null; then
  echo "Directus already running, leaving it untouched."
else
  ( cd "$ROOT/directus/api" && PATH="$NODE_DIR/bin:$PATH" pnpm cli bootstrap ) \
    || { echo "FATAL: Directus bootstrap failed" >&2; exit 1; }
  ( cd "$ROOT/directus/api" && PATH="$NODE_DIR/bin:$PATH" nohup pnpm cli start > "$ROOT/directus.log" 2>&1 & echo $! > "$ROOT/directus.pid" )
  wait_for_port 8055 Directus /server/ping || warn "check $ROOT/directus.log"
fi

# --------------------------------- 8. Restore schema, start Camunda
log "[8/9] Restoring Directus schema + starting Camunda"
ADMIN_EMAIL_VAL=$(grep '^ADMIN_EMAIL=' "$ROOT/directus/api/.env" | cut -d= -f2)
ADMIN_PASSWORD_VAL=$(grep '^ADMIN_PASSWORD=' "$ROOT/directus/api/.env" | cut -d= -f2)
DIRECTUS_URL=http://localhost:8055 \
DIRECTUS_ADMIN_EMAIL="$ADMIN_EMAIL_VAL" \
DIRECTUS_ADMIN_PASSWORD="$ADMIN_PASSWORD_VAL" \
  node "$ROOT/ops/promote-directus-schema.mjs" "$ROOT/directus/schema/directus-schema.json" \
  || warn "Schema promotion failed — confirm Directus is up, then re-run: node ops/promote-directus-schema.mjs directus/schema/directus-schema.json"

DIRECTUS_URL=http://localhost:8055 \
DIRECTUS_ADMIN_EMAIL="$ADMIN_EMAIL_VAL" \
DIRECTUS_ADMIN_PASSWORD="$ADMIN_PASSWORD_VAL" \
  node "$ROOT/ops/seed-directus-portal-users.mjs" \
  || warn "Portal user seed failed — re-run: node ops/seed-directus-portal-users.mjs"

if [ -n "$JDK_DIR" ] && [ -d "$ROOT/camunda-module/internal" ]; then
  if curl -sf http://127.0.0.1:8080/engine-rest/version -o /dev/null 2>/dev/null; then
    echo "Camunda already running, leaving it untouched."
  else
    ( cd "$ROOT/camunda-module" && JAVA_HOME="$JDK_DIR" PATH="$JDK_DIR/bin:$PATH" \
        nohup ./internal/run.sh start > "$ROOT/camunda-boot.log" 2>&1 & )
    wait_for_port 8080 Camunda || warn "check $ROOT/camunda-boot.log"
  fi
else
  warn "Skipping Camunda start — JDK or Camunda binary is missing (see warnings above)."
fi

# --------------------------------------------------- 9. Start Platform
log "[9/9] Starting Platform"
if curl -sf http://127.0.0.1:4000/api/health -o /dev/null 2>/dev/null; then
  echo "Platform already running, leaving it untouched."
else
  ( cd "$ROOT/platform" && NODE_ENV=production nohup npm start > "$ROOT/platform.log" 2>&1 & echo $! > "$ROOT/platform.pid" )
  wait_for_port 4000 Platform /api/health || warn "check $ROOT/platform.log"
fi

echo -e "\n============================================"
echo " Open http://localhost:4000"
echo " Demo logins: applicant/applicant123, specialist/specialist123, head/head123, admin/admin123"
echo " Logs: directus.log, camunda-boot.log, platform.log"
echo " VM firewall/security group: expose 4000 (or proxy it through HTTPS); keep 5432, 8055 and 8080 private."
echo "============================================"
