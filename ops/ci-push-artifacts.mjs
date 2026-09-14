#!/usr/bin/env node
// GitHub Actions → UAT Platform CI promote (schema + Camunda BPMN/DMN).
//
// Env: UAT_PLATFORM_URL, CI_PROMOTE_API_KEY
// Flags: --check-env
//
// CI_PROMOTE_SCRIPT_VERSION=4

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_VERSION = 4;
console.log(`CI_PROMOTE_SCRIPT_VERSION=${SCRIPT_VERSION}`);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PATH = path.join(repoRoot, 'directus', 'schema', 'directus-schema.json');
const RESOURCES_DIR = path.join(repoRoot, 'camunda-module', 'configuration', 'resources');

function normalizePlatformUrl(raw) {
  let base = String(raw || '').trim();
  if ((base.startsWith('"') && base.endsWith('"')) || (base.startsWith("'") && base.endsWith("'"))) {
    base = base.slice(1, -1).trim();
  }
  base = base.replace(/\/$/, '');
  if (base && !/^https?:\/\//i.test(base)) base = `https://${base}`;
  try {
    new URL(base);
  } catch {
    console.error('UAT_PLATFORM_URL must be a valid absolute URL, e.g. https://omandp.paradigmit.com');
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
  console.error('CI_PROMOTE_API_KEY is empty in this job.');
  process.exit(1);
}

console.log(`Target platform host: ${new URL(base).host}`);
console.log(`Repo root: ${repoRoot}`);
console.log(`Schema path: ${SCHEMA_PATH}`);
console.log(`argv: ${JSON.stringify(process.argv)}`);

if (process.argv.includes('--check-env')) {
  console.log('CI_PROMOTE_API_KEY is set');
  process.exit(0);
}

function loadSchemaJson(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Schema file missing: ${filePath}`);
  }
  const buf = readFileSync(filePath);
  const magic = [...buf.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`Schema magic bytes: ${magic} (${buf.length} bytes)`);
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    throw new Error(`Refusing to parse ELF executable at ${filePath}`);
  }
  if (buf[0] !== 0x7b && buf[0] !== 0x5b) {
    // 0x7b='{' 0x5b='['
    throw new Error(`Schema file is not JSON (first byte 0x${buf[0].toString(16)}) at ${filePath}`);
  }
  return JSON.parse(buf.toString('utf8'));
}

async function post(pathname, body) {
  const url = `${base}${pathname}`;
  console.log(`POST ${pathname} (${JSON.stringify(body).length} bytes body)`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': key,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`← ${res.status} content-type=${res.headers.get('content-type') || '(none)'} body=${text.length}b`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    throw new Error(`${pathname} → ${res.status}: ${json.error || text.slice(0, 300)}`);
  }
  return json;
}

const schema = loadSchemaJson(SCHEMA_PATH);
console.log('Promoting Directus schema…');
const schemaResult = await post('/api/ci/promote-schema', schema);
console.log(schemaResult.log || schemaResult);

const files = {};
for (const name of readdirSync(RESOURCES_DIR).filter((f) => /\.(bpmn|dmn)$/i.test(f))) {
  files[name] = readFileSync(path.join(RESOURCES_DIR, name), 'utf8');
}
console.log(`Promoting ${Object.keys(files).length} Camunda resource(s)…`);
const camundaResult = await post('/api/ci/promote-camunda', { files });
console.log(camundaResult.log || camundaResult);

console.log('UAT promotion complete.');
