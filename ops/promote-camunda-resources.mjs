#!/usr/bin/env node
// Deploys every .bpmn/.dmn file in the given resources directory to a
// target Camunda REST API (UAT), using the same multipart /deployment/create
// contract as the Platform BFF's own camundaClient.js. deploy-changed-only
// means files whose content hasn't changed since the last UAT deployment
// are skipped automatically by the engine.
//
// Runs in CI (promote-uat.yml), pointed at UAT via env var: CAMUNDA_URL

const [, , resourcesDir] = process.argv;
if (!resourcesDir) {
  console.error('usage: promote-camunda-resources.mjs <resources-dir>');
  process.exit(1);
}

const { CAMUNDA_URL } = process.env;
if (!CAMUNDA_URL) {
  console.error('CAMUNDA_URL must be set');
  process.exit(1);
}

const { readdirSync, readFileSync } = await import('node:fs');
const path = await import('node:path');

const files = readdirSync(resourcesDir).filter((f) => f.endsWith('.bpmn') || f.endsWith('.dmn'));
if (files.length === 0) {
  console.log('No .bpmn/.dmn files found — nothing to deploy.');
  process.exit(0);
}

const form = new FormData();
form.append('deployment-name', `uat-promotion-${new Date().toISOString()}`);
form.append('deployment-source', 'github-actions');
form.append('deploy-changed-only', 'true');
for (const file of files) {
  const buf = readFileSync(path.join(resourcesDir, file));
  form.append(file, new Blob([buf]), file);
}

const res = await fetch(`${CAMUNDA_URL}/deployment/create`, { method: 'POST', body: form });
if (!res.ok) throw new Error(`deployment/create failed: ${res.status} ${await res.text()}`);
const result = await res.json();

const changed = [
  ...Object.keys(result.deployedProcessDefinitions ?? {}),
  ...Object.keys(result.deployedDecisionDefinitions ?? {}),
];
console.log(`Deployed to UAT Camunda: deployment id ${result.id}`);
console.log(changed.length ? `Changed: ${changed.join(', ')}` : 'No process/decision definitions changed (files were identical to what UAT already has).');
