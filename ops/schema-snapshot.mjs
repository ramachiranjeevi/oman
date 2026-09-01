#!/usr/bin/env node
// Captures the current DEV Directus schema as a committable snapshot file —
// the source of truth a PR reviewer diffs, and what promote-directus-schema.mjs
// later applies to UAT via the same /schema/diff + /schema/apply REST contract
// Directus's own CLI uses.
//
// Run this on your DEV machine after making field/collection changes:
//   node ops/schema-snapshot.mjs

const DIRECTUS_URL = process.env.DIRECTUS_URL || 'http://localhost:8055';
const EMAIL = process.env.DIRECTUS_SERVICE_EMAIL || 'admin@example.com';
const PASSWORD = process.env.DIRECTUS_SERVICE_PASSWORD;
const OUT = process.argv[2] || 'directus/schema/directus-schema.json';

if (!PASSWORD) {
  console.error('Set DIRECTUS_SERVICE_PASSWORD in your environment before running.');
  process.exit(1);
}

const { writeFileSync } = await import('node:fs');

const loginRes = await fetch(`${DIRECTUS_URL}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status} ${await loginRes.text()}`);
const { data: { access_token } } = await loginRes.json();

const snapRes = await fetch(`${DIRECTUS_URL}/schema/snapshot`, {
  headers: { Authorization: `Bearer ${access_token}` },
});
if (!snapRes.ok) throw new Error(`schema/snapshot failed: ${snapRes.status} ${await snapRes.text()}`);
const { data: snapshot } = await snapRes.json();

writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');
console.log(`Wrote ${OUT}`);
console.log('Review with `git diff`, then commit and open a PR to promote to UAT.');
