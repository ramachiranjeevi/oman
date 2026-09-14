#!/usr/bin/env node
// Used by GitHub Actions (promote-uat.yml) to push committed schema/BPMN/DMN
// artifacts to the UAT Platform CI endpoints. Platform then applies them to
// local Directus/Camunda (not exposed on the public internet).
//
// Env:
//   UAT_PLATFORM_URL   e.g. https://omandp.paradigmit.com
//   CI_PROMOTE_API_KEY  shared secret (X-Api-Key)
//
// CI_PROMOTE_SCRIPT_VERSION=3

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

console.log('CI_PROMOTE_SCRIPT_VERSION=3');

function normalizePlatformUrl(raw) {
  let base = String(raw || '').trim();
  if ((base.startsWith('"') && base.endsWith('"')) || (base.startsWith("'") && base.endsWith("'"))) {
    base = base.slice(1, -1).trim();
  }
  base = base.replace(/\/$/, '');
  if (base && !/^https?:\/\//i.test(base)) {
    base = `https://${base}`;
  }
  try {
    new URL(base);
  } catch {
    console.error(
      'UAT_PLATFORM_URL must be a valid absolute URL, e.g. https://omandp.paradigmit.com',
      '(no quotes, no path — check the repository secret value)',
    );
    process.exit(1);
  }
  return base;
}

const base = normalizePlatformUrl(process.env.UAT_PLATFORM_URL);
const key = String(process.env.CI_PROMOTE_API_KEY || '').trim();
if (!base) {
  console.error('UAT_PLATFORM_URL is missing or invalid.');
  process.exit(1);
}
if (!key) {
  console.error(
    'CI_PROMOTE_API_KEY is empty in this job.',
    'GitHub always shows secret values as blank in the UI — that is normal.',
    'If you set the key on the repo but the job still sees empty, check',
    'Settings → Environments → uat → Environment secrets: a same-named secret',
    'there overrides the repo secret (delete it or paste the value again).',
  );
  process.exit(1);
}
console.log(`Target platform: ${base}`);

const checkOnly = process.argv.includes('--check-env');
if (checkOnly) {
  console.log('CI_PROMOTE_API_KEY is set');
  process.exit(0);
}

// Defaults only — do not treat argv[0]/node binary) as a schema path.
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('-')) {
    return process.argv[i + 1];
  }
  const prefix = `${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const schemaPath = argValue('--schema') || 'directus/schema/directus-schema.json';
const resourcesDir = argValue('--resources') || 'camunda-module/configuration/resources';

function readJsonFile(filePath, label) {
  const raw = readFileSync(filePath);
  const head = raw.subarray(0, 4).toString('binary');
  if (head.startsWith('\x7fELF') || head.startsWith('MZ')) {
    throw new Error(
      `${label}: ${filePath} looks like a binary executable, not JSON. ` +
        'Check CI argv / checkout — refusing to parse.',
    );
  }
  const text = raw.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!text.startsWith('{') && !text.startsWith('[')) {
    throw new Error(
      `${label}: ${filePath} does not look like JSON (starts with ${JSON.stringify(text.slice(0, 40))})`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label}: failed to parse ${filePath}: ${err.message}`);
  }
}

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
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
  if (!res.ok) {
    throw new Error(`${pathname} → ${res.status}: ${json.error || text.slice(0, 500)}`);
  }
  return json;
}

console.log(`Schema file: ${schemaPath}`);
const schema = readJsonFile(schemaPath, 'Directus schema');
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
