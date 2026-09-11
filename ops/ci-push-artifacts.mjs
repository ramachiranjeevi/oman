#!/usr/bin/env node
// Used by GitHub Actions (promote-uat.yml) to push committed schema/BPMN/DMN
// artifacts to the UAT Platform CI endpoints. Platform then applies them to
// local Directus/Camunda (not exposed on the public internet).
//
// Env:
//   UAT_PLATFORM_URL   e.g. https://omandp.paradigmit.com
//   CI_PROMOTE_API_KEY  shared secret (X-Api-Key)

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const base = (process.env.UAT_PLATFORM_URL || '').replace(/\/$/, '');
const key = process.env.CI_PROMOTE_API_KEY || '';
if (!base || !key) {
  console.error('UAT_PLATFORM_URL and CI_PROMOTE_API_KEY must be set');
  process.exit(1);
}

const schemaPath = process.argv[2] || 'directus/schema/directus-schema.json';
const resourcesDir = process.argv[3] || 'camunda-module/configuration/resources';

async function post(pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': key,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`${pathname} → ${res.status}: ${json.error || text}`);
  }
  return json;
}

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
console.log('Promoting Directus schema…');
const schemaResult = await post('/api/ci/promote-schema', schema);
console.log(schemaResult.log || schemaResult);

const files = {};
for (const name of readdirSync(resourcesDir).filter((f) => /\.(bpmn|dmn)$/i.test(f))) {
  files[name] = readFileSync(path.join(resourcesDir, name), 'utf8');
}
console.log(`Promoting ${Object.keys(files).length} Camunda resource(s)…`);
const camundaResult = await post('/api/ci/promote-camunda', { files });
console.log(camundaResult.log || camundaResult);

console.log('UAT promotion complete.');
