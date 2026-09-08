#!/usr/bin/env node
// Applies a committed Directus schema snapshot to a target instance (UAT)
// via the same /schema/diff + /schema/apply REST contract Directus's own
// CLI uses — verified against a live instance: /schema/diff returns 204
// when the target already matches, otherwise {data:{hash,diff}} which is
// posted as-is to /schema/apply.
//
// Runs in CI (promote-uat.yml), pointed at UAT via env vars:
//   DIRECTUS_URL, DIRECTUS_ADMIN_EMAIL, DIRECTUS_ADMIN_PASSWORD

const [, , snapshotPath] = process.argv;
if (!snapshotPath) {
  console.error('usage: promote-directus-schema.mjs <snapshot.json>');
  process.exit(1);
}

const { DIRECTUS_URL, DIRECTUS_ADMIN_EMAIL, DIRECTUS_ADMIN_PASSWORD } = process.env;
if (!DIRECTUS_URL || !DIRECTUS_ADMIN_EMAIL || !DIRECTUS_ADMIN_PASSWORD) {
  console.error('DIRECTUS_URL, DIRECTUS_ADMIN_EMAIL, DIRECTUS_ADMIN_PASSWORD must be set');
  process.exit(1);
}

const { readFileSync } = await import('node:fs');
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));

// This repo runs Directus on Postgres (see ops/ensure-postgres*). Older
// snapshots may still declare vendor "sqlite"; schema/diff rejects that
// mismatch even when the collection/field payload is otherwise valid.
if (snapshot.vendor && snapshot.vendor !== 'postgres') {
  console.log(`Rewriting snapshot vendor "${snapshot.vendor}" → "postgres"`);
  snapshot.vendor = 'postgres';
}

const loginRes = await fetch(`${DIRECTUS_URL}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: DIRECTUS_ADMIN_EMAIL, password: DIRECTUS_ADMIN_PASSWORD }),
});
if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status} ${await loginRes.text()}`);
const { data: { access_token } } = await loginRes.json();
const headers = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };

const diffRes = await fetch(`${DIRECTUS_URL}/schema/diff`, { method: 'POST', headers, body: JSON.stringify(snapshot) });
if (diffRes.status === 204) {
  console.log('Directus schema on UAT already matches the committed snapshot — nothing to apply.');
  process.exit(0);
}
if (!diffRes.ok) throw new Error(`schema/diff failed: ${diffRes.status} ${await diffRes.text()}`);
const { data: diff } = await diffRes.json();

console.log('Schema diff to apply:', JSON.stringify({
  collections: diff.diff.collections?.length ?? 0,
  fields: diff.diff.fields?.length ?? 0,
  relations: diff.diff.relations?.length ?? 0,
}));

const applyRes = await fetch(`${DIRECTUS_URL}/schema/apply`, { method: 'POST', headers, body: JSON.stringify(diff) });
if (!applyRes.ok) throw new Error(`schema/apply failed: ${applyRes.status} ${await applyRes.text()}`);
console.log('Directus schema applied to UAT successfully.');
