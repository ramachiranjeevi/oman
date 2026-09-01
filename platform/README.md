# Platform Module — BFF + Web UI

The orchestration layer. Talks to the Directus module and the Camunda module
purely over REST — never exposes either backend's own UI to end users.

## Run

```
npm install
npm run dev
```

Web UI: http://localhost:4000
API: http://localhost:4000/api/*

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/applications` | Create a `license_applications` record in Directus, start the Camunda `cinema_film_screening_license` process with the record id as businessKey |
| GET | `/api/applications` | List applications (Directus) |
| GET | `/api/applications/:id` | Get one application + its Camunda process instance id |
| GET | `/api/tasks?group=<candidateGroup>` | List Camunda user tasks for a candidate group (`applicant`, `specialist`, `head_of_section`) |
| POST | `/api/tasks/:id/complete` | Complete a Camunda task, optionally patch the Directus record in the same call |

## Why this shape

This is the "Phase 2" REST extraction layer from the platform architecture:
Directus's own Admin App is gated behind `admin_access` for its Settings
module (see `../directus/app/src/modules/settings/index.ts`), and Camunda's
own Tasklist/Cockpit are separate apps with their own auth. Routing everything
through this single BFF means:

- The web UI never needs Directus or Camunda credentials — only this API
- Directus and Camunda can be swapped, upgraded, or reconfigured independently
  as long as this API contract holds
- Business/orchestration rules that don't belong in either backend (e.g.
  "when a task completes, also patch the Directus record") live here, in one
  place
