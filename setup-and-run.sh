#!/usr/bin/env bash
# Fully automated setup + run for a fresh checkout of this repo, on Linux.
#
# Downloads the pinned Node 22 / JDK 17 runtimes and Camunda Platform Run
# into .tools/ if they aren't already there, installs JS dependencies,
# creates .env files with dev-only defaults if they don't already exist,
# restores the Directus schema snapshot, then starts all three modules.
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

# ---------------------------------------------------------------- 1. Node
log "[1/8] Node ${NODE_VERSION}"
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
log "[2/8] JDK 17 (Temurin)"
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
log "[3/8] Camunda Platform Run ${CAMUNDA_VERSION}"
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
log "[4/8] Installing dependencies"
corepack enable 2>/dev/null || true
( cd "$ROOT/directus" && pnpm install ) || { echo "FATAL: pnpm install failed in directus/" >&2; exit 1; }
( cd "$ROOT/platform" && npm install ) || { echo "FATAL: npm install failed in platform/" >&2; exit 1; }

# ------------------------------------------------------- 5. .env files
log "[5/8] Environment files"
DEV_PASSWORD="ChangeMe123!"   # dev-only default — change for anything beyond local testing

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

wait_for_port() {
  local port=$1 name=$2 tries=60
  echo -n "waiting for $name on port $port"
  while ! curl -sf "http://localhost:$port" -o /dev/null 2>/dev/null; do
    tries=$((tries - 1))
    [ $tries -le 0 ] && { echo " — timed out."; return 1; }
    echo -n "."; sleep 2
  done
  echo " up."
}

# --------------------------------------------------- 6. Start Directus
log "[6/8] Starting Directus"
( cd "$ROOT/directus/api" && PATH="$NODE_DIR/bin:$PATH" nohup pnpm run dev > "$ROOT/directus-dev.log" 2>&1 & )
wait_for_port 8055 Directus || warn "check $ROOT/directus-dev.log"

# --------------------------------- 7. Restore schema, start Camunda
log "[7/8] Restoring Directus schema + starting Camunda"
ADMIN_EMAIL_VAL=$(grep '^ADMIN_EMAIL=' "$ROOT/directus/api/.env" | cut -d= -f2)
ADMIN_PASSWORD_VAL=$(grep '^ADMIN_PASSWORD=' "$ROOT/directus/api/.env" | cut -d= -f2)
DIRECTUS_URL=http://localhost:8055 \
DIRECTUS_ADMIN_EMAIL="$ADMIN_EMAIL_VAL" \
DIRECTUS_ADMIN_PASSWORD="$ADMIN_PASSWORD_VAL" \
  node "$ROOT/ops/promote-directus-schema.mjs" "$ROOT/directus/schema/directus-schema.json" \
  || warn "Schema promotion failed — confirm Directus is up, then re-run: node ops/promote-directus-schema.mjs directus/schema/directus-schema.json"

if [ -n "$JDK_DIR" ] && [ -d "$ROOT/camunda-module/internal" ]; then
  ( cd "$ROOT/camunda-module" && JAVA_HOME="$JDK_DIR" PATH="$JDK_DIR/bin:$PATH" \
      nohup ./internal/run.sh start > "$ROOT/camunda-boot.log" 2>&1 & )
  wait_for_port 8080 Camunda || warn "check $ROOT/camunda-boot.log"
else
  warn "Skipping Camunda start — JDK or Camunda binary is missing (see warnings above)."
fi

# --------------------------------------------------- 8. Start Platform
log "[8/8] Starting Platform"
( cd "$ROOT/platform" && nohup npm run dev > "$ROOT/platform-dev.log" 2>&1 & )
wait_for_port 4000 Platform || warn "check $ROOT/platform-dev.log"

echo -e "\n============================================"
echo " Open http://localhost:4000"
echo " Demo logins: applicant/applicant123, specialist/specialist123, head/head123, admin/admin123"
echo "============================================"
