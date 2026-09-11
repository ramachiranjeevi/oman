# CI/CD: DEV → UAT promotion

How field/schema changes (Directus) and process/flow changes (Camunda BPMN
+ DMN) move from a developer's machine to UAT, with a human approval gate in
between. Built on **GitHub Actions**.

## Recap (what we show)

```text
DEV (change fields / BPMN)
  → git commit + PR
  → validate job (XML/JSON check + change summary)
  → human PR approval + merge to main
  → promote-uat job waits on GitHub Environment "uat"
  → human "Approve and deploy"
  → Actions POSTs artifacts to https://omandp…/api/ci/*
  → Platform on UAT applies to local Directus + Camunda
```

Two approval gates (both native GitHub UI — good for the tender demo):

1. **PR review** — content approval  
2. **Environment `uat`** — deploy approval (separate click)

## Why via Platform (not Directus/Camunda URLs)

UAT keeps Directus `:8055` and Camunda `:8080` **private** (see `SETUP.md`).
GitHub-hosted runners cannot reach them. Instead:

| Secret | Points at |
|---|---|
| `UAT_PLATFORM_URL` | Public portal, e.g. `https://omandp.paradigmit.com` |
| `CI_PROMOTE_API_KEY` | Same value as `CI_PROMOTE_API_KEY` in UAT `platform/.env` |

Platform endpoints (API-key only, no login session):

- `POST /api/ci/promote-schema` — body = `directus-schema.json`
- `POST /api/ci/promote-camunda` — body = `{ files: { "x.bpmn": "…", … } }`

Scripts: `ops/ci-push-artifacts.mjs` (CI) → `ops/promote-directus-schema.mjs` /
`ops/promote-camunda-resources.mjs` (on the UAT box).

## The two artifact types

| Artifact | Lives at | Promotion mechanism |
|---|---|---|
| Directus fields/collections | `directus/schema/directus-schema.json` | `/schema/diff` + `/schema/apply` |
| Camunda process + DMN | `camunda-module/configuration/resources/*.bpmn`, `*.dmn` | `/deployment/create` (`deploy-changed-only`) |

Git is the source of truth; GitHub is the approval system.

## Developer workflow

```bash
# Field change (Admin → Add a Form Field, or Directus)
node ops/schema-snapshot.mjs

# Process change (canvas or Advanced bpmn-js)
node ops/export-camunda-resources.mjs

git add directus/schema camunda-module/configuration/resources
git commit -m "..."
git push -u origin my-change-branch
# open a PR against main
```

## One-time GitHub setup

1. **Environment `uat`** — Settings → Environments → New environment `uat` →
   add a **required reviewer**.
2. **Repo secrets** (Settings → Secrets and variables → Actions):
   - `UAT_PLATFORM_URL` = `https://omandp.paradigmit.com`
   - `CI_PROMOTE_API_KEY` = same random string as on the VM
3. **Branch protection** on `main` (optional but recommended for the demo):
   require a PR + ≥1 approval before merge.
4. **UAT Platform `.env`**: set `CI_PROMOTE_API_KEY=...` and restart Platform.

Manual demo without a config file change: Actions → **Promote to UAT** →
**Run workflow** (`workflow_dispatch`). Still waits for the `uat` environment
approval.

## What this pipeline deliberately does not cover

- Application code (`platform/`) — normal software deploy (SCP/pull), not
  config promotion. Add a separate workflow if you want code deploys gated too.
- In-flight Camunda instances stay on the process version they started on;
  new BPMN only affects instances started after redeploy.
