// Phase 3 demo: simulated CI/CD promotion log. There is only one real
// environment in this sandbox (no separate DEV/UAT Camunda+Directus
// stacks), so "promotion" is simulated per the RFP's explicit allowance —
// disclosed as SIMULATED in the UI. What's NOT fake: the snapshot taken at
// promotion time is read live from the actual deployed DMN/BPMN and
// worker config, not hardcoded, so it reflects whatever Phase 1/2 edits
// were really made.

let log = [];
let nextId = 1;

export function addEntry(snapshot, approvedBy) {
  const entry = {
    id: nextId++,
    deploymentId: `UAT-DEPLOY-${Date.now()}`,
    promotedAt: new Date().toISOString(),
    approvedBy: approvedBy || 'Unspecified Approver',
    snapshot,
  };
  log = [entry, ...log];
  return entry;
}

export function getLog() {
  return log;
}
