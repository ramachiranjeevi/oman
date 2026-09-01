# CI/CD: DEV → UAT promotion

How field/schema changes (Directus) and process/flow changes (Camunda BPMN
+ DMN) move from a developer's machine to UAT, with a human approval gate in
between. Built on GitHub Actions since UAT is network-reachable from GitHub.

## The two artifact types

| Artifact | Lives at | Promotion mechanism |
|---|---|---|
| Directus fields/collections | `directus/schema/directus-schema.json` | Directus's own `/schema/diff` + `/schema/apply` REST contract |
| Camunda process (BPMN) + decision table (DMN) | `camunda-module/configuration/resources/*.bpmn`, `*.dmn` | Redeploy via `/deployment/create` (`deploy-changed-only`, so unmodified files are skipped) |

Both are just files under version control — nothing bespoke, no custom
approval database. Git is the source of truth; GitHub is the approval
system.

## Developer workflow

After making changes on DEV (via the Platform app's admin tools, or
Directus/Camunda directly):

```bash
# Made a field change (Admin tab -> Add a Form Field, or in Directus itself)
node ops/schema-snapshot.mjs

# Made a process change (Simple canvas or Advanced bpmn-js editor)
node ops/export-camunda-resources.mjs

git add directus/schema camunda-module/configuration/resources
git commit -m "..."
git push -u origin my-change-branch
# open a PR against main
```

## The two approval gates

1. **Pull request review.** The PR diff is human-readable: the schema
   snapshot is JSON (new/changed fields are visible line by line), and the
   BPMN/DMN files are XML that GitHub renders as a text diff. A CI job
   (`validate`) also runs on every PR to catch malformed XML/JSON before a
   human even looks at it, and posts a summary of exactly which config
   files changed. Requires **branch protection** on `main` (Settings →
   Branches → require a pull request + at least one approval) — a one-time
   repo setting, not something a workflow file can turn on by itself.

2. **Deployment approval.** Merging to `main` queues the `promote-uat` job,
   but it does not run automatically — it's gated on a GitHub
   **Environment** named `uat` with a required reviewer. The job sits
   "Waiting" until that reviewer clicks **Review deployments → Approve and
   deploy** in the Actions tab. This is the literal "approval in between"
   step, separate from the code-review approval above — someone can approve
   the PR content today and still hold off on actually pushing it to UAT
   until a scheduled window.

Both gates show up as ordinary GitHub UI (PR reviews, deployment approvals)
— nothing to explain to the customer beyond "this is what GitHub's own
review and environment-protection features do."

## What actually happens on approval

`.github/workflows/promote-uat.yml`, job `promote-uat`:

1. `ops/promote-directus-schema.mjs` — logs into UAT's Directus, diffs the
   committed snapshot against UAT's current schema, applies only the
   difference. No-ops cleanly if UAT already matches.
2. `ops/promote-camunda-resources.mjs` — redeploys the `.bpmn`/`.dmn` files
   to UAT's Camunda REST API. `deploy-changed-only` means files whose
   content didn't change produce no new version on UAT.

Both scripts talk to UAT purely over REST (same "REST calls only" boundary
the rest of this platform already uses) — no SSH, no direct DB access
needed, which is why this works cleanly even though DEV and UAT are
separate machines.

## One-time setup required (cannot be done from a workflow file)

- **Branch protection** on `main`: require a PR + ≥1 approval before merge.
- **Environment `uat`** (Settings → Environments → New environment): add a
  required reviewer.
- **Repo secrets**: `UAT_DIRECTUS_URL`, `UAT_DIRECTUS_ADMIN_EMAIL`,
  `UAT_DIRECTUS_ADMIN_PASSWORD`, `UAT_CAMUNDA_URL`.

## What this pipeline deliberately does not cover

- Application code changes (`platform/`) — those are a normal software
  release, not a config promotion; add a separate workflow/gate for that if
  needed.
- In-flight Camunda process instances stay on whichever process version
  they started on — promoting a new BPMN version only affects instances
  started after the redeploy, matching how Camunda versioning always works.
