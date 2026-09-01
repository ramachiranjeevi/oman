// In-memory, live-editable platform configuration for settings that don't
// belong in a deployed BPMN/DMN artifact (e.g. worker-side scheduling
// parameters). Deliberately NOT persisted to Directus/disk — resets to
// defaults on restart. Everything that needs to survive a restart lives in
// the process engine's own deployed resources instead (see camundaClient.js).

let state = {
  fieldVisitLeadTimeDays: 3,
};

export function getConfig() {
  return { ...state };
}

export function updateConfig(partial) {
  state = { ...state, ...partial };
  return { ...state };
}
