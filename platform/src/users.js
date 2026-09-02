// Demo user directory for Platform login. Deliberately NOT backed by
// Directus's own auth/RBAC (that's the license-walled, unwired system
// documented elsewhere) — this is the Platform's own session source of
// truth. In-memory, plaintext, resets on restart: same tradeoff already
// accepted for config.js/pipelineLog.js and for ADMIN_PASSWORD in
// directus/api/.env.

const USERS = [
  { username: 'applicant', password: 'applicant123', role: 'applicant', displayName: 'Citizen / Applicant' },
  { username: 'specialist', password: 'specialist123', role: 'specialist', displayName: 'A/V Classifications Specialist' },
  { username: 'head', password: 'head123', role: 'head_of_section', displayName: 'Head of Cinema Section' },
  { username: 'admin', password: 'admin123', role: 'admin', displayName: 'Ministry Admin' },
];

export const ROLE_TABS = {
  applicant: ['applicant'],
  specialist: ['specialist'],
  head_of_section: ['head'],
  admin: ['admin', 'dashboard'],
};

export const ROLE_CANDIDATE_GROUP = {
  applicant: 'applicant',
  specialist: 'specialist',
  head_of_section: 'head_of_section',
};

export function findUser(username, password) {
  const user = USERS.find((u) => u.username === username && u.password === password);
  if (!user) return null;
  const { password: _password, ...safe } = user;
  return safe;
}
