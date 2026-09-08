// In-memory, live-editable platform configuration for settings that don't
// belong in a deployed BPMN/DMN artifact (e.g. worker-side scheduling
// parameters, portal field↔role permissions). Deliberately NOT persisted to
// Directus/disk — resets to defaults on restart. Everything that needs to
// survive a restart lives in the process engine's own deployed resources
// instead (see camundaClient.js).

/** Portal roles that appear in the Phase 1.2 permission matrix. */
export const PERMISSION_ROLES = ['applicant', 'specialist', 'head_of_section', 'admin'];

/** Allowed access levels for a field × role cell. */
export const ACCESS_LEVELS = ['write', 'read', 'hidden'];

const DEFAULT_ACCESS = 'write';

let state = {
  fieldVisitLeadTimeDays: 3,
  // fieldKey → { role → 'write'|'read'|'hidden' }. Missing cells = write.
  fieldPermissions: {},
};

export function getConfig() {
  return {
    fieldVisitLeadTimeDays: state.fieldVisitLeadTimeDays,
    fieldPermissions: clonePermissions(state.fieldPermissions),
  };
}

export function updateConfig(partial) {
  if (partial.fieldVisitLeadTimeDays !== undefined) {
    state.fieldVisitLeadTimeDays = partial.fieldVisitLeadTimeDays;
  }
  if (partial.fieldPermissions !== undefined) {
    state.fieldPermissions = normalizeMatrix(partial.fieldPermissions);
  }
  return getConfig();
}

export function getFieldAccess(field, role) {
  const cell = state.fieldPermissions[field]?.[role];
  return ACCESS_LEVELS.includes(cell) ? cell : DEFAULT_ACCESS;
}

/**
 * Set one cell in the live matrix. Returns the new access for that cell.
 */
export function setFieldAccess(field, role, access) {
  if (!PERMISSION_ROLES.includes(role)) {
    throw new Error(`Unknown role "${role}"`);
  }
  if (!ACCESS_LEVELS.includes(access)) {
    throw new Error(`access must be one of: ${ACCESS_LEVELS.join(', ')}`);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(field)) {
    throw new Error('field key must be snake_case');
  }
  if (!state.fieldPermissions[field]) state.fieldPermissions[field] = {};
  if (access === DEFAULT_ACCESS) {
    delete state.fieldPermissions[field][role];
    if (Object.keys(state.fieldPermissions[field]).length === 0) {
      delete state.fieldPermissions[field];
    }
  } else {
    state.fieldPermissions[field][role] = access;
  }
  return getFieldAccess(field, role);
}

export function getPermissionsMatrix(fieldKeys) {
  const matrix = {};
  for (const field of fieldKeys) {
    matrix[field] = {};
    for (const role of PERMISSION_ROLES) {
      matrix[field][role] = getFieldAccess(field, role);
    }
  }
  return matrix;
}

function normalizeMatrix(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [field, roles] of Object.entries(raw)) {
    if (!roles || typeof roles !== 'object') continue;
    for (const [role, access] of Object.entries(roles)) {
      if (!PERMISSION_ROLES.includes(role) || !ACCESS_LEVELS.includes(access)) continue;
      if (access === DEFAULT_ACCESS) continue;
      if (!out[field]) out[field] = {};
      out[field][role] = access;
    }
  }
  return out;
}

function clonePermissions(src) {
  const out = {};
  for (const [field, roles] of Object.entries(src)) {
    out[field] = { ...roles };
  }
  return out;
}
