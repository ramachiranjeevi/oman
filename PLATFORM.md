# Oman Info Platform — Three-Module Architecture

Built to close the BPM/workflow gap identified when evaluating Directus alone
against the MOI Digital Platform tender's demo script (DTM-T-007-26).

```
                 ┌─────────────────────┐
   Citizen /     │   PLATFORM MODULE    │   ./platform
   Staff Browser │  (Web UI + BFF API)  │   port 4000
                 └──────────┬───────────┘
                             │ REST calls only
                 ┌───────────┴───────────┐
                 │                       │
        ┌────────▼────────┐    ┌─────────▼────────┐
        │ DIRECTUS MODULE  │    │  CAMUNDA MODULE   │
        │ (data/forms/RBAC)│◄───┤ (BPM/DMN/tasks)   │
        │ ./directus        │    │ ./camunda-module  │
        │ port 8055         │    │ port 8080          │
        └──────────────────┘    └───────────────────┘
```

## Modules

| Module | Path | Port | Owns |
|---|---|---|---|
| Platform | `./platform` | 4000 | Web UI, BFF/API gateway, orchestration between the other two |
| Directus | `./directus` | 8055 | Data model (`license_applications`), RBAC, Insights dashboards |
| Camunda | `./camunda-module` | 8080 | BPMN process, DMN decision tables, task assignment, SLA/escalation |

Each module is independently runnable and independently demoable, matching
the tender's phased demo script:

- **Tender Phase 1 (Configuration)** → Directus module: add field live,
  change role permission live, change fee value live
- **Tender Phase 2 (Automation)** → Camunda module: eligibility rule change,
  auto-scheduling, native revision loop, SLA escalation
- **Tender Phase 3 (Integration)** → Platform module's BFF: the REST contract
  wiring the two together, plus where external system calls would attach
- **Tender Phase 4 (Simulation)** → Platform module's web UI: full citizen +
  staff journey end to end
- **Tender Phase 5 (Measurement)** → Directus Insights, fed by data both
  modules write back

## Starting everything

```
# 1. Directus (already built — see ./directus/CLAUDE.md)
cd directus/api && run-with-node22.bat     # http://localhost:8055
# (pins the bundled Node 22 in .tools/ — isolated-vm's native module is
#  compiled against Node 22's ABI and crashes on newer/older Node)

# 2. Camunda
cd camunda-module && run-with-jdk17.bat    # http://localhost:8080

# 3. Platform
cd platform && npm install && npm run dev  # http://localhost:4000
```

## Business process modeled

**Cinema Film Screening License** (إجازة عرض فيلم سينمائي) — the exact
process named in the tender's demo script, end to end:

Submit → Eligibility + Fee (DMN) → Pay Fee → Auto-schedule Field Visit →
Field Visit Evaluation (Specialist) → Head of Section Review
[SLA 1hr, escalates on breach] → Approve / Comments (loop back) / Reject →
Issue License + QR

See `camunda-module/README.md` and `platform/README.md` for module-level detail.
