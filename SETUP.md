# First-time setup on a new machine

This repo deliberately keeps a few things out of git (see `.gitignore`):
local `.env` files, the downloaded Node/JDK runtimes under `.tools/`, and
the Camunda Platform Run binary distribution. None of that is optional at
runtime, so a plain `git clone` will not run until you do the steps below
once. (See `PLATFORM.md` for the module architecture itself — this doc is
just "how do I get a checkout running.")

For an Ubuntu/Debian x86_64 VM, the automated path is:

```bash
chmod +x setup-and-run.sh ops/ensure-postgres.sh
OMAN_ADMIN_PASSWORD='replace-with-a-strong-password' ./setup-and-run.sh
```

The script installs missing OS packages through `apt`, enables Docker,
downloads pinned Node 22 and JDK 17 runtimes locally, downloads Camunda Run,
installs locked JavaScript dependencies, creates secrets, starts Postgres,
restores/seeds Directus, and starts all services. Allow at least 3 GB RAM
(4 GB recommended) and 8 GB free disk. Open TCP 4000 in the VM firewall or
reverse-proxy it through HTTPS; do not publicly expose 5432, 8055, or 8080.

The remaining manual instructions are useful for Windows or troubleshooting.

## 1. Prerequisites

| Tool | Version | Why exactly this version |
|---|---|---|
| Node.js | **22.x** (developed against 22.22.0) | Directus's `isolated-vm` native module is prebuilt against Node 22's ABI — a different major version fails to load at startup (`ERR_DLOPEN_FAILED`). |
| JDK | **17** (developed against Temurin 17.0.13+11) | Required by Camunda Platform Run 7.22.0. |
| PostgreSQL | **17.x** (local or Docker) | Shared server for Directus (`oman_directus`) and Camunda (`oman_camunda`). |
| pnpm | `>=10 <11` (pinned via `packageManager` in `directus/package.json`) | Fetched automatically by Corepack — see step 3. |
| Docker Desktop | optional but recommended | Easiest way to run Postgres: `docker compose up -d postgres`. |

Whatever Node you already have installed globally can be anything — the
scripts below pin Node 22 locally per-module, they don't touch your
system Node.

## 2. Fetch the pinned runtimes into `.tools/`

These are gitignored because they're binary downloads, not source. Create
`.tools/` at the repo root and put both of these inside it:

**Node 22.22.0 (Windows x64)**
1. Download: https://nodejs.org/dist/v22.22.0/node-v22.22.0-win-x64.zip
2. Extract so you end up with `.tools/node-v22.22.0-win-x64/node.exe`
   (i.e. extract the zip's top-level folder directly into `.tools/`).

**JDK 17 (Eclipse Temurin)**
1. Download from Adoptium: https://adoptium.net/temurin/releases/?version=17
   (Windows x64, JDK, .zip). Any 17.0.x Temurin build works; the project
   was built against `17.0.13+11`.
2. Extract into `.tools/` so you end up with `.tools/jdk-17.0.13+11/bin/java.exe`
   (rename the extracted folder if the downloaded version number differs,
   or update `camunda-module/run-with-jdk17.bat`'s `JAVA_HOME` line to match).

If you use a different JDK build/version, just point
`camunda-module/run-with-jdk17.bat`'s `JAVA_HOME` at wherever you put it —
the exact folder name isn't load-bearing, only that it's a real JDK 17.

## 3. Fetch Camunda Platform Run 7.22.0

`camunda-module/configuration/` (the BPMN/DMN resources, `default.yml`,
etc.) is already checked out and correctly configured for this project —
only the actual Java application binary is excluded.

1. Download Camunda Platform Run 7.22.0 from
   https://camunda.com/download/camunda-platform-7/ (select "Camunda Run").
2. Extract the zip somewhere temporary.
3. Copy just the extracted `internal/` folder into
   `camunda-module/internal/` — **do not** overwrite
   `camunda-module/configuration/`, which is already set up correctly in
   this repo.

## 4. Install JS dependencies

```
corepack enable

cd directus
pnpm install
pnpm --filter @directus/api... build

cd ../platform
npm install
```

`corepack enable` is what lets `pnpm` resolve to the exact version pinned
in `directus/package.json` automatically.

## 5. Create your `.env` files

```
cp directus/api/.env.example directus/api/.env
cp platform/.env.example platform/.env
```

Fill in real values — at minimum:
- `directus/api/.env`: generate fresh `KEY`/`SECRET` UUIDs, set `ADMIN_EMAIL`/`ADMIN_PASSWORD`. Postgres defaults (`oman` / `oman_dev` / `oman_directus`) match `docker-compose.yml`.
- `platform/.env`: generate a `SESSION_SECRET`, and set `DIRECTUS_SERVICE_EMAIL`/`DIRECTUS_SERVICE_PASSWORD` to **the same values** as Directus's `ADMIN_EMAIL`/`ADMIN_PASSWORD` above — the Platform BFF logs into Directus as that account.

## 6. Start Postgres

One Postgres server, two databases (`oman_directus`, `oman_camunda`). Dev credentials: user `oman`, password `oman_dev`.

**Preferred (Docker):**

```
docker compose up -d postgres
```

Or run `ops/ensure-postgres.ps1` (Windows) / `ops/ensure-postgres.sh` (Linux), which also downloads the Camunda JDBC jar into `camunda-module/configuration/userlib/`.

**Without Docker:** install PostgreSQL 17, then:

```sql
CREATE USER oman WITH PASSWORD 'oman_dev';
CREATE DATABASE oman_directus OWNER oman;
CREATE DATABASE oman_camunda OWNER oman;
```

## 7. Start everything (order matters)

```
# 0. Postgres (see step 6)
docker compose up -d postgres

# 1. Directus — pins Node 22 automatically
cd directus/api
pnpm cli bootstrap
run-with-node22.bat

# 2. Camunda — pins JDK 17 automatically
cd camunda-module
run-with-jdk17.bat

# 3. Platform
cd platform
npm run dev
```

Directus and Camunda create their tables on first boot against Postgres.
Camunda auto-deploys everything under `configuration/resources/` on boot.

## 8. Restore the Directus schema

A fresh Directus database has Directus's own system tables and your admin user,
but not the `license_applications` collection/fields this app actually
uses — that's tracked separately as a schema snapshot. With Directus
running from step 7:

```
DIRECTUS_URL=http://localhost:8055 \
DIRECTUS_ADMIN_EMAIL=<your ADMIN_EMAIL> \
DIRECTUS_ADMIN_PASSWORD=<your ADMIN_PASSWORD> \
node ops/promote-directus-schema.mjs directus/schema/directus-schema.json
```

(This is the same script the CI/CD pipeline in `CICD.md` uses to promote
DEV → UAT — running it against your own fresh local instance is exactly
the same operation.)

Also seed portal identity (Directus roles + demo users used by Platform login):

```
DIRECTUS_URL=http://localhost:8055 \
DIRECTUS_ADMIN_EMAIL=<your ADMIN_EMAIL> \
DIRECTUS_ADMIN_PASSWORD=<your ADMIN_PASSWORD> \
node ops/seed-directus-portal-users.mjs
```

Demo usernames still work (`applicant` / `applicant123`, …); they map to
Directus emails such as `applicant@example.com`.

## 9. Verify

Open http://localhost:4000 — you should see the BPM login screen. Demo
accounts (seeded into Directus by `ops/seed-directus-portal-users.mjs`):

| Username | Password | Role |
|---|---|---|
| `applicant` | `applicant123` | Citizen / Applicant |
| `specialist` | `specialist123` | A/V Classifications Specialist |
| `head` | `head123` | Head of Cinema Section |
| `admin` | `admin123` | Ministry Admin |

## Troubleshooting

- **Directus / Camunda fail with connection refused on port 5432** — Postgres is not running. Start it with `docker compose up -d postgres`, or install PostgreSQL and create `oman_directus` / `oman_camunda` (see step 6).
- **Directus crashes on startup with `Cannot find module '.../@directus/env/dist/index.js'` (`ERR_MODULE_NOT_FOUND`)** — this is a Directus source checkout; workspace packages must be compiled after install. From `directus/`: `pnpm --filter @directus/api... build`. `setup-and-run` does this automatically on a fresh machine.
- **Directus crashes on startup with `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` mismatch** — you're running it with the wrong Node version. Use `run-with-node22.bat`, don't run `pnpm dev` directly with your system Node.
- **setup-and-run reports Directus timed out but the process is actually up** — fixed by health-checking `/server/ping` (root `/` redirects to disabled `/admin`). Re-run the latest script.
- **Camunda won't start / wrong Java version error** — same idea, use `run-with-jdk17.bat`, and confirm `.tools/jdk-17.0.13+11/bin/java.exe` actually exists.
- **Applicant tab shows no fields / "Applications" table errors** — you skipped schema restore; the `license_applications` collection doesn't exist yet on a fresh database.
- **Platform BFF logs `Directus auth failed`** — `DIRECTUS_SERVICE_EMAIL`/`PASSWORD` in `platform/.env` don't match `ADMIN_EMAIL`/`ADMIN_PASSWORD` in `directus/api/.env`.
