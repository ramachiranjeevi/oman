#!/usr/bin/env node
// Pulls the currently-deployed BPMN process and DMN decision table from a
// local (DEV) Camunda engine and writes them into
// camunda-module/configuration/resources/ — turning live canvas / Advanced
// Editor edits into real, committable file changes before a promotion PR.
//
// Run this on your DEV machine after editing the process/decision table:
//   node ops/export-camunda-resources.mjs

const CAMUNDA_URL = process.env.CAMUNDA_URL || 'http://localhost:8080/engine-rest';
const OUT_DIR = process.argv[2] || 'camunda-module/configuration/resources';

const { writeFileSync } = await import('node:fs');

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

const proc = await fetchJson(`${CAMUNDA_URL}/process-definition/key/cinema_film_screening_license/xml`);
writeFileSync(`${OUT_DIR}/cinema_film_screening_license.bpmn`, proc.bpmn20Xml);
console.log(`Wrote ${OUT_DIR}/cinema_film_screening_license.bpmn`);

const dmn = await fetchJson(`${CAMUNDA_URL}/decision-definition/key/cinema_eligibility_and_fee/xml`);
writeFileSync(`${OUT_DIR}/cinema_eligibility_and_fee.dmn`, dmn.dmnXml);
console.log(`Wrote ${OUT_DIR}/cinema_eligibility_and_fee.dmn`);

console.log('Review with `git diff`, then commit and open a PR to promote to UAT.');
