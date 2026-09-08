import 'dotenv/config';

const DIRECTUS_URL = process.env.DIRECTUS_URL;
const SERVICE_EMAIL = process.env.DIRECTUS_SERVICE_EMAIL;
const SERVICE_PASSWORD = process.env.DIRECTUS_SERVICE_PASSWORD;

let cachedToken = null;
let tokenExpiresAt = 0;

async function getServiceToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const res = await fetch(`${DIRECTUS_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: SERVICE_EMAIL, password: SERVICE_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Directus auth failed: ${res.status}`);
  const { data } = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires - 5000);
  return cachedToken;
}

async function directusFetch(path, options = {}) {
  const token = await getServiceToken();
  const res = await fetch(`${DIRECTUS_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Directus ${options.method || 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

export async function createApplication(payload) {
  const { data } = await directusFetch('/items/license_applications', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return data;
}

export async function getApplication(id) {
  const { data } = await directusFetch(`/items/license_applications/${id}`);
  return data;
}

export async function updateApplication(id, payload) {
  const { data } = await directusFetch(`/items/license_applications/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  return data;
}

export async function listApplications() {
  const { data } = await directusFetch('/items/license_applications?sort=-date_created&limit=500');
  return data;
}

export async function getApplicationByLicenseQr(code) {
  const filter = encodeURIComponent(String(code || ''));
  const { data } = await directusFetch(
    `/items/license_applications?filter%5Blicense_qr%5D%5B_eq%5D=${filter}&limit=1`,
  );
  return data[0] || null;
}

export async function getFormSchema(collection) {
  const { data } = await directusFetch(`/fields/${collection}`);
  return data
    .filter((f) => !f.meta?.hidden && !['id', 'date_created', 'status', 'review_outcome', 'field_visit_notes', 'eligible', 'review_comments', 'field_visit_date', 'sla_breached', 'revision_loop_used', 'license_qr', 'payment_method', 'license_issued_at', 'applicant_notified', 'notification_message'].includes(f.field))
    .sort((a, b) => (a.meta?.sort ?? 0) - (b.meta?.sort ?? 0))
    .map((f) => ({
      field: f.field,
      type: f.type,
      interface: f.meta?.interface ?? 'input',
      note: f.meta?.note ?? null,
      options: f.meta?.options ?? {},
      required: f.meta?.required ?? false,
    }));
}

// --- Admin configuration (Phase 1 demo: live schema edits) -----------------

export async function addField(fieldDef) {
  await directusFetch('/fields/license_applications', {
    method: 'POST',
    body: JSON.stringify(fieldDef),
  });
}

export async function deleteField(field) {
  await directusFetch(`/fields/license_applications/${encodeURIComponent(field)}`, {
    method: 'DELETE',
  });
}

export async function ensureField(fieldDef) {
  try {
    await addField(fieldDef);
    return { created: true };
  } catch (err) {
    if (/already exists|duplicate|RECORD_NOT_UNIQUE/i.test(err.message)) {
      return { created: false, reason: 'exists' };
    }
    console.error(`[ensureField] failed to create "${fieldDef.field}":`, err.message);
    return { created: false, reason: err.message };
  }
}

export async function ensureStatusChoice(value, text) {
  const { data: field } = await directusFetch('/fields/license_applications/status');
  const choices = field.meta?.options?.choices ?? [];
  if (choices.some((c) => c.value === value)) return { updated: false };
  await directusFetch('/fields/license_applications/status', {
    method: 'PATCH',
    body: JSON.stringify({ meta: { options: { ...field.meta.options, choices: [...choices, { text, value }] } } }),
  });
  return { updated: true };
}

// --- Reporting / telemetry (Phase 5 demo) -----------------------------------

function sinceFilter(sinceIso) {
  return sinceIso ? `&filter%5Bdate_created%5D%5B_gte%5D=${encodeURIComponent(sinceIso)}` : '';
}

export async function countAll(sinceIso) {
  const { data } = await directusFetch(`/items/license_applications?aggregate%5Bcount%5D=id${sinceFilter(sinceIso)}`);
  return data[0]?.count?.id ?? 0;
}

export async function groupByCount(field, sinceIso) {
  const { data } = await directusFetch(
    `/items/license_applications?aggregate%5Bcount%5D=id&groupBy%5B%5D=${encodeURIComponent(field)}${sinceFilter(sinceIso)}`
  );
  return data;
}

export async function avgOf(field, sinceIso) {
  const { data } = await directusFetch(`/items/license_applications?aggregate%5Bavg%5D=${encodeURIComponent(field)}${sinceFilter(sinceIso)}`);
  return data[0]?.avg?.[field] ?? null;
}

export async function listApplicationsPendingEligibility() {
  const { data } = await directusFetch('/items/license_applications?filter%5Beligible%5D%5B_null%5D=true&limit=-1');
  return data;
}

/**
 * Authenticate a portal user against Directus. Returns the Directus user
 * record (with role.name), or null if credentials are invalid.
 *
 * Portal roles have no Directus app permissions, so /users/me under the
 * user token only returns `id`. After a successful login we load the full
 * profile with the service account.
 */
export async function authenticatePortalUser(email, password) {
  const res = await fetch(`${DIRECTUS_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) return null;

  const { data: tokens } = await res.json();
  let userId = null;
  try {
    const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString('utf8'));
    userId = payload.id;
  } catch {
    userId = null;
  }
  if (!userId) return null;

  // Best-effort logout of the ephemeral Directus session.
  fetch(`${DIRECTUS_URL}/auth/logout`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refresh_token: tokens.refresh_token }),
  }).catch(() => {});

  const { data: me } = await directusFetch(
    `/users/${userId}?fields=id,email,first_name,last_name,role.id,role.name`,
  );
  return me;
}
