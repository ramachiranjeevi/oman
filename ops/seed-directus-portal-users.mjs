#!/usr/bin/env node
// Idempotent seed of Platform portal roles + demo users into Directus.
// Identity lives in Directus; Platform maps Directus role names → session
// roles / Camunda candidate groups (see platform/src/users.js).
//
// Env: DIRECTUS_URL, DIRECTUS_ADMIN_EMAIL, DIRECTUS_ADMIN_PASSWORD
// (same service account the Platform BFF uses for schema/items).

const { DIRECTUS_URL, DIRECTUS_ADMIN_EMAIL, DIRECTUS_ADMIN_PASSWORD } = process.env;
if (!DIRECTUS_URL || !DIRECTUS_ADMIN_EMAIL || !DIRECTUS_ADMIN_PASSWORD) {
  console.error('DIRECTUS_URL, DIRECTUS_ADMIN_EMAIL, DIRECTUS_ADMIN_PASSWORD must be set');
  process.exit(1);
}

const ROLES = [
  { name: 'applicant', description: 'Citizen / Applicant (Platform portal)', app_access: false, admin_access: false },
  { name: 'specialist', description: 'A/V Classifications Specialist', app_access: false, admin_access: false },
  { name: 'head_of_section', description: 'Head of Cinema Section', app_access: false, admin_access: false },
  { name: 'platform_admin', description: 'Ministry Admin (Platform portal)', app_access: false, admin_access: false },
];

const USERS = [
  {
    email: 'applicant@example.com',
    password: 'applicant123',
    roleName: 'applicant',
    first_name: 'Citizen',
    last_name: 'Applicant',
  },
  {
    email: 'specialist@example.com',
    password: 'specialist123',
    roleName: 'specialist',
    first_name: 'A/V',
    last_name: 'Specialist',
  },
  {
    email: 'head@example.com',
    password: 'head123',
    roleName: 'head_of_section',
    first_name: 'Head',
    last_name: 'of Section',
  },
  {
    // Not admin@example.com — that remains the Directus service/admin account.
    email: 'ministry-admin@example.com',
    password: 'admin123',
    roleName: 'platform_admin',
    first_name: 'Ministry',
    last_name: 'Admin',
  },
];

async function login() {
  const res = await fetch(`${DIRECTUS_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: DIRECTUS_ADMIN_EMAIL, password: DIRECTUS_ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const { data } = await res.json();
  return data.access_token;
}

async function api(token, method, path, body) {
  const res = await fetch(`${DIRECTUS_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return json;
}

const token = await login();

const rolesRes = await api(token, 'GET', '/roles?limit=-1&fields=id,name');
const rolesByName = new Map((rolesRes.data || []).map((r) => [r.name, r]));

for (const role of ROLES) {
  if (rolesByName.has(role.name)) {
    console.log(`role exists: ${role.name}`);
    continue;
  }
  const created = await api(token, 'POST', '/roles', role);
  rolesByName.set(role.name, created.data);
  console.log(`role created: ${role.name}`);
}

const usersRes = await api(token, 'GET', '/users?limit=-1&fields=id,email');
const usersByEmail = new Map((usersRes.data || []).map((u) => [String(u.email).toLowerCase(), u]));

for (const u of USERS) {
  const role = rolesByName.get(u.roleName);
  if (!role) throw new Error(`missing role ${u.roleName}`);
  const existing = usersByEmail.get(u.email.toLowerCase());
  if (existing) {
    await api(token, 'PATCH', `/users/${existing.id}`, {
      role: role.id,
      status: 'active',
      first_name: u.first_name,
      last_name: u.last_name,
      password: u.password,
    });
    console.log(`user updated: ${u.email} → ${u.roleName}`);
  } else {
    await api(token, 'POST', '/users', {
      email: u.email,
      password: u.password,
      role: role.id,
      status: 'active',
      first_name: u.first_name,
      last_name: u.last_name,
    });
    console.log(`user created: ${u.email} → ${u.roleName}`);
  }
}

console.log('Portal identity seed complete.');
console.log('Demo logins (Platform username / password):');
console.log('  applicant/applicant123, specialist/specialist123, head/head123, admin/admin123');
