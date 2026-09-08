// Platform portal identity maps. Passwords live in Directus (seeded by
// ops/seed-directus-portal-users.mjs); this file only maps usernames →
// emails, Directus role names → Platform roles, and roles → Camunda groups.
// Tab visibility for the UI lives in public/index.html (ROLE_TABS).

/** Login aliases accepted by the Platform UI (demo-friendly usernames). */
const USERNAME_TO_EMAIL = {
  applicant: 'applicant@example.com',
  specialist: 'specialist@example.com',
  head: 'head@example.com',
  admin: 'ministry-admin@example.com',
};

/** Directus role.name → Platform session role. */
export const DIRECTUS_ROLE_TO_PLATFORM = {
  applicant: 'applicant',
  specialist: 'specialist',
  head_of_section: 'head_of_section',
  platform_admin: 'admin',
};

export const ROLE_CANDIDATE_GROUP = {
  applicant: 'applicant',
  specialist: 'specialist',
  head_of_section: 'head_of_section',
};

export const ROLE_DISPLAY_NAME = {
  applicant: 'Citizen / Applicant',
  specialist: 'A/V Classifications Specialist',
  head_of_section: 'Head of Cinema Section',
  admin: 'Ministry Admin',
};

/** Resolve UI username-or-email to a Directus login email. */
export function resolveLoginEmail(usernameOrEmail) {
  const raw = String(usernameOrEmail || '').trim();
  if (!raw) return null;
  if (raw.includes('@')) return raw.toLowerCase();
  return USERNAME_TO_EMAIL[raw.toLowerCase()] || null;
}

/** Prefer a short username alias for the session badge. */
export function emailToUsername(email) {
  const lower = String(email || '').toLowerCase();
  const hit = Object.entries(USERNAME_TO_EMAIL).find(([, e]) => e === lower);
  return hit ? hit[0] : lower.split('@')[0];
}
