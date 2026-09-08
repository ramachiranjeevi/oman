# Camunda Module — BPM engine

Camunda Platform 7 ("Camunda Run" distribution), running under a portable JDK 17
(`../.tools/jdk-17.0.13+11`), independent of the Directus and Platform modules.

Process data is stored in Postgres database `oman_camunda` (see repo-root
`docker-compose.yml` and `configuration/default.yml`). The Postgres JDBC driver
must be present in `configuration/userlib/` (`ops/ensure-postgres.ps1` downloads it).

## Start

```
# Postgres must already be up (docker compose up -d postgres)
run-with-jdk17.bat
```

REST API base: `http://localhost:8080/engine-rest`
Tasklist / Cockpit: `http://localhost:8080/camunda`  (login: demo / demo)

## What's deployed

- `configuration/resources/cinema_film_screening_license.bpmn` — the Cinema Film
  Screening License process: eligibility DMN check, fee payment, auto-scheduled
  field visit, Specialist evaluation, Head of Section review with a 1-hour SLA
  timer and escalation, and a native revision loop (comments → back to
  evaluation) — the exact BPM capability Directus's Flows module cannot provide.
- `configuration/resources/cinema_eligibility_and_fee.dmn` — the eligibility and
  fee decision table. Editing the base fee or SME discount is a DMN table edit,
  not a code change — this directly answers the tender's "change fee logic
  entirely through admin tools" requirement.

Camunda auto-deploys everything under `configuration/resources/` on boot
(`deploy-changed-only: true` in `configuration/default.yml`).

## Candidate groups used by the process

- `applicant` — pays the fee
- `specialist` — Audio-Visual Classifications Specialist, field visit evaluation
- `head_of_section` — Head of Cinema Section, final review (approve / comments / reject)

The Platform module's Task Inbox pages query `/task?candidateGroup=<group>`
and complete tasks via `/task/:id/complete`.
