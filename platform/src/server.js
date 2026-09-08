import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as directus from './directusClient.js';
import * as camunda from './camundaClient.js';
import { startExternalTaskWorker } from './externalTaskWorker.js';
import * as platformConfig from './config.js';
import * as mockIntegrations from './mockIntegrations.js';
import * as pipelineLog from './pipelineLog.js';
import * as processCanvas from './processCanvas.js';
import { issueLicenseAndNotify } from './licenseService.js';
import {
  ROLE_CANDIDATE_GROUP,
  ROLE_DISPLAY_NAME,
  DIRECTUS_ROLE_TO_PLATFORM,
  resolveLoginEmail,
  emailToUsername,
} from './users.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'oman-info-platform-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.SESSION_COOKIE_SECURE === 'true',
      maxAge: 8 * 60 * 60 * 1000,
    },
  })
);
app.use(express.static(path.join(__dirname, '..', 'public')));

const PROCESS_KEY = 'cinema_film_screening_license';

// --- Auth (Directus users/roles; Platform session + requireRole enforce) ---

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const email = resolveLoginEmail(username);
    if (!email || !password) return res.status(401).json({ error: 'Invalid username or password' });

    const me = await directus.authenticatePortalUser(email, password);
    if (!me) return res.status(401).json({ error: 'Invalid username or password' });

    const directusRoleName = me.role?.name;
    const role = DIRECTUS_ROLE_TO_PLATFORM[directusRoleName];
    if (!role) {
      return res.status(403).json({ error: `Directus role "${directusRoleName || 'none'}" is not mapped to a Platform role` });
    }

    const displayName =
      [me.first_name, me.last_name].filter(Boolean).join(' ') ||
      ROLE_DISPLAY_NAME[role] ||
      email;

    const user = {
      id: me.id,
      email: me.email,
      username: emailToUsername(me.email),
      role,
      displayName,
    };
    req.session.user = user;
    res.json(user);
  } catch (err) {
    console.error('[auth/login]', err.message);
    res.status(502).json({ error: 'Identity provider unavailable' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.status(204).end());
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  res.json(req.session.user);
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    if (!roles.includes(req.session.user.role)) return res.status(403).json({ error: 'Forbidden for this role' });
    next();
  };
}

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path.startsWith('/public/licenses/') || req.path === '/public/app-origin' || req.path === '/health') return next();
  return requireAuth(req, res, next);
});

// --- Applications (Directus-backed) -----------------------------------

// Public QR verification endpoint. The QR payload is an unguessable license
// code; only certificate-safe fields are returned (never the full application).
app.get('/api/public/app-origin', (req, res) => {
  const requestHost = req.get('host') || '';
  if (requestHost && !/^(localhost|127\.0\.0\.1|\[::1\])(?::|$)/i.test(requestHost)) {
    return res.json({ origin: `${req.protocol}://${requestHost}` });
  }
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
  const preferred = addresses.find((address) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address));
  res.json({ origin: preferred ? `${req.protocol}://${preferred}:${port}` : `${req.protocol}://${requestHost}` });
});

app.get('/api/public/licenses/:code', async (req, res) => {
  try {
    const record = await directus.getApplicationByLicenseQr(req.params.code);
    if (!record?.license_qr) return res.status(404).json({ valid: false, error: 'License not found' });
    res.json({
      valid: true,
      licenseNumber: record.license_qr,
      applicationId: record.id,
      filmTitle: record.film_title || '',
      directorName: record.applicant_name || '',
      classification: record.classification || '',
      language: record.language || '',
      productionCountry: record.production_country || '',
      productionYear: record.production_year || '',
      issueDate: record.license_issued_at || record.date_updated || record.date_created,
      status: record.status,
      issuer: 'Ministry of Information — Sultanate of Oman',
      service: 'Cinema Film Screening License',
    });
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

app.post('/api/applications', requireRole('applicant', 'admin'), async (req, res) => {
  try {
    const role = req.session.user.role;
    // Drop fields the caller's role may not write (Phase 1.2 live RBAC).
    const writable = {};
    for (const [key, value] of Object.entries(req.body || {})) {
      if (key === 'status') continue;
      if (platformConfig.getFieldAccess(key, role) === 'write') writable[key] = value;
    }
    const record = await directus.createApplication({
      status: 'submitted',
      ...writable,
    });
    const eligibilityInputs = {
      validCommercialRegistration: !!writable.valid_commercial_registration,
      validPriorPracticeLicense: !!writable.valid_prior_practice_license,
      hasRiyadaCard: !!writable.has_riyada_card,
    };
    const started = await camunda.startProcess(PROCESS_KEY, record.id, {
      applicationId: String(record.id),
      ...eligibilityInputs,
    });
    // Evaluate the same DMN directly so the record carries eligibility/fee
    // immediately, without waiting on process/history data (feeds the
    // Phase 5 telemetry dashboard in real time).
    const evaluated = await camunda.evaluateDecision('cinema_eligibility_and_fee', eligibilityInputs);
    if (evaluated) {
      await directus.updateApplication(record.id, { eligible: evaluated.eligible, final_fee: evaluated.finalFee });
      record.eligible = evaluated.eligible;
      record.final_fee = evaluated.finalFee;
    }
    // Custom canvases can route Start straight to End — Camunda finishes
    // immediately with no user task, so status would otherwise stay "submitted".
    // Treat a finished instance as process end: completed + license + notify.
    const instanceId = started?.id;
    if (instanceId && !(await camunda.isProcessInstanceActive(instanceId))) {
      const issued = await issueLicenseAndNotify(record.id);
      Object.assign(record, issued);
    }
    res.status(201).json(record);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/applications', async (req, res) => {
  try {
    const rows = await directus.listApplications();
    res.json(rows.map((row) => redactApplicationForRole(row, req.session.user.role)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/applications/:id', async (req, res) => {
  try {
    const record = await directus.getApplication(req.params.id);
    const process = await camunda.getProcessInstanceByBusinessKey(PROCESS_KEY, req.params.id);
    const visible = redactApplicationForRole(record, req.session.user.role);
    res.json({ ...visible, processInstanceId: process?.id ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** System / process columns never gated by the portal field-permission matrix. */
const PERMISSION_EXEMPT_FIELDS = new Set([
  'id', 'status', 'date_created', 'date_updated', 'user_created', 'user_updated',
  'eligible', 'final_fee', 'review_outcome', 'review_comments', 'field_visit_notes',
  'field_visit_date', 'sla_breached', 'revision_loop_used', 'license_qr',
  'payment_method', 'license_issued_at', 'applicant_notified', 'notification_message',
]);

function redactApplicationForRole(record, role) {
  if (!record || typeof record !== 'object') return record;
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (PERMISSION_EXEMPT_FIELDS.has(key)) {
      out[key] = value;
      continue;
    }
    if (platformConfig.getFieldAccess(key, role) === 'hidden') continue;
    out[key] = value;
  }
  return out;
}

// --- Phase 3 demo: simulated external/internal lookups ------------------
// Disclosed as simulated in both the response payload and the UI — see
// mockIntegrations.js. No real Oman Business Platform / ROP Civil Status
// connectivity exists in this sandbox.

app.post('/api/integrations/cr-lookup', (req, res) => {
  res.json(mockIntegrations.lookupCommercialRegistration(req.body.crNumber));
});

app.post('/api/integrations/civil-status-lookup', (req, res) => {
  res.json(mockIntegrations.lookupCivilStatus(req.body.civilId));
});

app.post('/api/integrations/practice-license-lookup', (req, res) => {
  res.json(mockIntegrations.lookupPracticeLicense(req.body.civilId));
});

// --- Task Inbox (Camunda-backed) ---------------------------------------

app.get('/api/tasks', async (req, res) => {
  try {
    const { role } = req.session.user;
    // Non-admin roles can only ever see their own candidate group's queue —
    // the group is derived from the session, never trusted from the client,
    // regardless of what ?group= is passed.
    const group = role === 'admin' ? req.query.group || 'specialist' : ROLE_CANDIDATE_GROUP[role];
    if (!group) return res.status(403).json({ error: 'This role has no task queue' });
    res.json(await camunda.listTasksForGroup(group));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Statuses the fixed task-completion buttons below set on the ASSUMPTION
// that more steps follow (built for the original multi-step flow). If a
// custom canvas routes that same task straight to an End event instead,
// the process instance is genuinely finished right after this task
// completes — so we check with Camunda and correct the status to
// 'completed' (and issue license + notify when the path is not a reject).
const NON_TERMINAL_STATUSES = new Set(['field_visit_scheduled', 'under_review', 'submitted']);

app.post('/api/tasks/:id/complete', async (req, res) => {
  try {
    const { variables, applicationId, applicationUpdate } = req.body;
    const task = applicationUpdate ? await camunda.getTask(req.params.id).catch(() => null) : null;
    await camunda.completeTask(req.params.id, variables || {});
    if (applicationId && applicationUpdate) {
      let finalUpdate = { ...applicationUpdate };
      if (task?.processInstanceId) {
        const stillActive = await camunda.isProcessInstanceActive(task.processInstanceId);
        if (!stillActive) {
          if (applicationUpdate.status === 'rejected') {
            // Reject end — leave rejected, no license.
          } else if (
            NON_TERMINAL_STATUSES.has(applicationUpdate.status)
            || applicationUpdate.status === 'approved'
            || applicationUpdate.status === 'completed'
          ) {
            const issued = await issueLicenseAndNotify(applicationId, { skipIfHasQr: true });
            finalUpdate = { ...finalUpdate, ...issued };
          }
        }
      }
      await directus.updateApplication(applicationId, finalUpdate);
    }
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/form-schema/:collection', async (req, res) => {
  try {
    const role = req.session.user.role;
    const schema = await directus.getFormSchema(req.params.collection);
    const filtered = [];
    for (const f of schema) {
      const access = platformConfig.getFieldAccess(f.field, role);
      if (access === 'hidden') continue;
      filtered.push({ ...f, access, readonly: access === 'read' });
    }
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, platform: 'up' });
});

// --- Admin Configuration Panel (Phase 1 demo) ---------------------------
// Both endpoints below go through Directus's / Camunda's own REST APIs
// only — the platform never touches either module's filesystem or DB
// directly, matching the "REST calls only" module boundary.

app.use('/api/admin', requireRole('admin'));

const FIELD_TYPE_PRESETS = {
  text: { type: 'string', interface: 'input' },
  longtext: { type: 'text', interface: 'input-multiline' },
  number: { type: 'float', interface: 'input' },
  boolean: { type: 'boolean', interface: 'boolean' },
  date: { type: 'date', interface: 'datetime' },
};

app.post('/api/admin/fields', async (req, res) => {
  try {
    const raw = req.body?.field;
    const field = String(raw || '')
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .toLowerCase();
    const { label, kind } = req.body || {};
    if (!field || !/^[a-z][a-z0-9_]*$/.test(field)) {
      return res.status(400).json({ error: 'field key must be snake_case, e.g. screening_date' });
    }
    const preset = FIELD_TYPE_PRESETS[kind] || FIELD_TYPE_PRESETS.text;
    await directus.addField({
      field,
      type: preset.type,
      meta: { interface: preset.interface, note: label || null, sort: 50 },
      schema: { is_nullable: true },
    });
    res.status(201).json({ field, kind: kind || 'text', label: label || null });
  } catch (err) {
    const exists = /already exists|duplicate|RECORD_NOT_UNIQUE/i.test(err.message);
    res.status(exists ? 409 : 500).json({ error: exists ? `Field "${req.body.field}" already exists` : err.message });
  }
});

// Fields the eligibility DMN, dashboard aggregates, or the submit/task-
// completion handlers above read by exact name — deleting these would break
// the app, not just the form, so they're not deletable from this panel.
const PROTECTED_FIELDS = new Set([
  'film_title', 'classification', 'applicant_name', 'has_riyada_card',
  'valid_commercial_registration', 'valid_prior_practice_license', 'final_fee',
]);

app.delete('/api/admin/fields/:field', async (req, res) => {
  if (PROTECTED_FIELDS.has(req.params.field)) {
    return res.status(400).json({ error: `"${req.params.field}" is a core field the process relies on and can't be deleted.` });
  }
  try {
    await directus.deleteField(req.params.field);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Phase 1.2 demo: live role → field permissions for the portal form.
// Stored in platform config (same live-edit pattern as schedule lead time);
// enforced on form-schema + application create/list/get for non-exempt fields.
app.get('/api/admin/field-permissions', async (_req, res) => {
  try {
    const fields = await directus.getFormSchema('license_applications');
    const fieldKeys = fields.map((f) => f.field);
    res.json({
      roles: platformConfig.PERMISSION_ROLES,
      accessLevels: platformConfig.ACCESS_LEVELS,
      fields: fields.map((f) => ({ field: f.field, type: f.type, note: f.note })),
      matrix: platformConfig.getPermissionsMatrix(fieldKeys),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/field-permissions', (req, res) => {
  try {
    const { field, role, access } = req.body || {};
    if (!field || !role || !access) {
      return res.status(400).json({ error: 'field, role, and access are required' });
    }
    const next = platformConfig.setFieldAccess(field, role, access);
    res.json({ field, role, access: next });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Phase 2 demo: SLA threshold editor. Reads/writes the boundary-timer
// duration on the deployed BPMN's Head of Section Review task. Set it low
// (e.g. 1-2 minutes) during a demo to actually watch the escalation fire
// live rather than waiting a real hour.
app.get('/api/admin/sla', async (_req, res) => {
  try {
    res.json({ slaMinutes: await camunda.getSlaMinutes() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/sla', async (req, res) => {
  try {
    const minutes = Number(req.body.slaMinutes);
    if (!Number.isInteger(minutes) || minutes < 1) {
      return res.status(400).json({ error: 'slaMinutes must be a positive integer' });
    }
    res.json(await camunda.updateSlaMinutes(minutes));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Phase 2 demo: auto-schedule lead time. Not backed by the process engine —
// it's a worker-side parameter (see externalTaskWorker.js's
// 'auto-schedule-field-visit' handler) — so it lives in the in-process
// config module and takes effect on the very next task the worker picks up.
app.get('/api/admin/schedule', async (_req, res) => {
  res.json(platformConfig.getConfig());
});

app.post('/api/admin/schedule', async (req, res) => {
  const days = Number(req.body.fieldVisitLeadTimeDays);
  if (!Number.isInteger(days) || days < 0) {
    return res.status(400).json({ error: 'fieldVisitLeadTimeDays must be a non-negative integer' });
  }
  res.json(platformConfig.updateConfig({ fieldVisitLeadTimeDays: days }));
});

app.get('/api/admin/pricing', async (_req, res) => {
  try {
    res.json(await camunda.getPricing());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/pricing', async (req, res) => {
  try {
    const baseFee = Number(req.body.baseFee);
    const smeDiscountPct = Number(req.body.smeDiscountPct);
    if (!Number.isFinite(baseFee) || baseFee < 0 || !Number.isFinite(smeDiscountPct) || smeDiscountPct < 0 || smeDiscountPct > 100) {
      return res.status(400).json({ error: 'baseFee and smeDiscountPct must be non-negative numbers (smeDiscountPct <= 100)' });
    }
    res.json(await camunda.updatePricing({ baseFee, smeDiscountPct }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Phase 2 demo: eligibility rule editor. Reads/writes the same DMN table as
// pricing above, toggling which of the two boolean conditions are required
// for eligibility. Both conditions are on by default (matches the original
// rule: valid Commercial Registration AND valid prior practice license).
app.get('/api/admin/eligibility-rule', async (_req, res) => {
  try {
    res.json(await camunda.getEligibilityRule());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/eligibility-rule', async (req, res) => {
  try {
    const requireCommercialRegistration = !!req.body.requireCommercialRegistration;
    const requirePriorPracticeLicense = !!req.body.requirePriorPracticeLicense;
    res.json(await camunda.updateEligibilityRule({ requireCommercialRegistration, requirePriorPracticeLicense }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-test both scenarios against the live rule without creating a Directus
// record — this is the "re-test met / not-met" step from the demo script.
app.post('/api/admin/eligibility-test', async (req, res) => {
  try {
    const evaluated = await camunda.evaluateDecision('cinema_eligibility_and_fee', {
      validCommercialRegistration: !!req.body.validCommercialRegistration,
      validPriorPracticeLicense: !!req.body.validPriorPracticeLicense,
      hasRiyadaCard: !!req.body.hasRiyadaCard,
    });
    res.json(evaluated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Process Canvas (PowerPoint-style drag shapes + draw connectors) -----

app.get('/api/admin/process-canvas/:key', (req, res) => {
  res.json(processCanvas.loadCanvas(req.params.key));
});

app.get('/api/admin/process-canvas-actions', (_req, res) => {
  res.json(processCanvas.AUTOMATIC_ACTIONS);
});

app.post('/api/admin/process-canvas/:key', async (req, res) => {
  try {
    const canvas = { ...req.body, processKey: req.params.key };
    const { xml } = processCanvas.compileCanvas(canvas);
    const saved = processCanvas.saveCanvas(req.params.key, canvas);
    const { version } = await camunda.deployProcessXml(req.params.key, xml, 'process-canvas');
    res.json({ ok: true, canvas: saved, version });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, validationErrors: err.validationErrors ?? [err.message] });
  }
});

// --- CI/CD Promotion (Phase 3 demo) --------------------------------------
// SIMULATED: this sandbox has one environment, not a real DEV/UAT split —
// disclosed as such in the UI. The snapshot itself is not fake: it's read
// live from the deployed DMN/BPMN and worker config at promotion time, so
// it reflects whatever Phase 1/2 edits actually happened.

async function buildPipelineSnapshot() {
  const [pricing, eligibility, slaMinutes] = await Promise.all([
    camunda.getPricing(),
    camunda.getEligibilityRule(),
    camunda.getSlaMinutes(),
  ]);
  return { pricing, eligibility, slaMinutes, fieldVisitLeadTimeDays: platformConfig.getConfig().fieldVisitLeadTimeDays };
}

app.get('/api/admin/pipeline/snapshot', async (_req, res) => {
  try {
    res.json(await buildPipelineSnapshot());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/pipeline/promote', async (req, res) => {
  try {
    if (!req.body.approved) {
      return res.status(400).json({ error: 'Approval gate not satisfied — check the approval box before promoting.' });
    }
    const snapshot = await buildPipelineSnapshot();
    res.status(201).json(pipelineLog.addEntry(snapshot, req.body.approvedBy));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/pipeline/log', (_req, res) => {
  res.json(pipelineLog.getLog());
});

// --- Telemetry Dashboard (Phase 5 demo) ----------------------------------

function currentMonthStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

function currentQuarterStart() {
  const now = new Date();
  const quarterMonth = Math.floor(now.getMonth() / 3) * 3;
  return new Date(now.getFullYear(), quarterMonth, 1).toISOString();
}

app.get('/api/dashboard/metrics', requireRole('admin'), async (_req, res) => {
  try {
    // The RFP's three headline KPIs are explicitly time-windowed: Requests
    // Received is monthly, % Meeting Conditions is quarterly, % Completed
    // Within Timeframe is monthly. Everything else on the dashboard stays
    // all-time (not specified as windowed in the demo script).
    const monthStart = currentMonthStart();
    const quarterStart = currentQuarterStart();

    const [requestsReceived, statusGroups, eligibleGroups, revisionLoopGroups, classificationGroups, avgFinalFee, finishedReviews, pendingApplicant, pendingSpecialist, pendingHeadOfSection] =
      await Promise.all([
        directus.countAll(monthStart),
        directus.groupByCount('status'),
        directus.groupByCount('eligible', quarterStart),
        directus.groupByCount('revision_loop_used'),
        directus.groupByCount('classification'),
        directus.avgOf('final_fee'),
        camunda.getFinishedTasks('Task_HeadOfSectionReview', monthStart),
        camunda.countTasksForGroup('applicant'),
        camunda.countTasksForGroup('specialist'),
        camunda.countTasksForGroup('head_of_section'),
      ]);

    // Postgres booleans come back through Directus's aggregate API as 1/0/null,
    // not JS true/false — coerce explicitly rather than comparing by identity.
    const boolBucket = (val) => (val === null ? null : Number(val) === 1);
    const statusCounts = Object.fromEntries(statusGroups.map((g) => [g.status ?? 'unknown', g.count.id]));
    const eligibleTrue = eligibleGroups.find((g) => boolBucket(g.eligible) === true)?.count.id ?? 0;
    const eligibleFalse = eligibleGroups.find((g) => boolBucket(g.eligible) === false)?.count.id ?? 0;
    const pendingEvaluation = eligibleGroups.find((g) => boolBucket(g.eligible) === null)?.count.id ?? 0;
    const evaluatedTotal = eligibleTrue + eligibleFalse;
    const eligiblePct = evaluatedTotal ? Math.round((eligibleTrue / evaluatedTotal) * 1000) / 10 : null;
    // Historical flag, not current status — see the ensureField note on
    // revision_loop_used above for why status alone undercounts this.
    const revisionLoopCount = revisionLoopGroups.find((g) => boolBucket(g.revision_loop_used) === true)?.count.id ?? 0;
    const classificationBreakdown = Object.fromEntries(
      classificationGroups.map((g) => [g.classification ?? 'Unspecified', g.count.id])
    );

    const completed = finishedReviews.filter((t) => t.deleteReason === 'completed');
    const breached = finishedReviews.filter((t) => t.deleteReason === 'deleted'); // cancelled by the SLA boundary timer
    const totalResolvedReviews = completed.length + breached.length;
    const withinSla = completed.filter((t) => typeof t.duration === 'number' && t.duration <= 3600000).length;
    const slaCompletionPct = totalResolvedReviews ? Math.round((withinSla / totalResolvedReviews) * 1000) / 10 : null;

    res.json({
      generatedAt: new Date().toISOString(),
      requestsReceivedPeriod: 'This Month',
      eligiblePctPeriod: 'This Quarter',
      slaCompletionPctPeriod: 'This Month',
      requestsReceived,
      eligiblePct,
      eligibleTrue,
      eligibleFalse,
      pendingEvaluation,
      eligibleTarget: 90,
      slaCompletionPct,
      slaWithinTarget: withinSla,
      slaTotalReviews: totalResolvedReviews,
      slaBreaches: breached.length,
      slaTarget: 90,
      avgFinalFee: avgFinalFee !== null ? Math.round(avgFinalFee * 100) / 100 : null,
      approved: statusCounts.approved ?? 0,
      rejected: statusCounts.rejected ?? 0,
      revisionLoopCount,
      pendingApplicant,
      pendingSpecialist,
      pendingHeadOfSection,
      statusCounts,
      classificationBreakdown,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Platform BFF listening on http://localhost:${port}`);
  startExternalTaskWorker();
  runStartupProvisioning();
});

// --- One-time-per-boot, idempotent provisioning --------------------------
// Ensures the support fields the new UI needs exist even if the admin never
// clicks the "Add Field" demo button, and backfills eligibility/fee data
// onto pre-existing records so the dashboard isn't empty on first load.

async function runStartupProvisioning() {
  try {
    await directus.ensureField({
      field: 'eligible',
      type: 'boolean',
      meta: { interface: 'boolean', note: 'Set from the eligibility DMN evaluation at submission time.', hidden: true },
      schema: { is_nullable: true },
    });
    await directus.ensureField({
      field: 'review_comments',
      type: 'text',
      meta: { interface: 'input-multiline', note: 'Head of Section comments when returning a task to the Specialist.' },
      schema: { is_nullable: true },
    });
    await directus.ensureField({
      field: 'field_visit_date',
      type: 'date',
      meta: { interface: 'datetime', note: 'Auto-scheduled by the platform worker using the live lead-time setting.' },
      schema: { is_nullable: true },
    });
    await directus.ensureField({
      field: 'sla_breached',
      type: 'boolean',
      meta: { interface: 'boolean', note: 'Set by the escalation worker when the Head of Section review misses its SLA.', options: { label: 'SLA breached (escalated)' } },
      schema: { is_nullable: true, default_value: false },
    });
    // Historical flag — set once, never cleared, so it accurately answers
    // "how many requests ever went through the revision loop" (the RFP's
    // own Phase 5.2 widget example). `status` alone can't answer that: it
    // gets overwritten once the loop resolves.
    await directus.ensureField({
      field: 'revision_loop_used',
      type: 'boolean',
      meta: { interface: 'boolean', note: 'True if this application was ever sent back to the Specialist for revision, regardless of current status.', options: { label: 'Went through the revision loop' } },
      schema: { is_nullable: true, default_value: false },
    });
    await directus.ensureField({
      field: 'license_qr',
      type: 'string',
      meta: { interface: 'input', note: 'QR payload set when the license is issued.', hidden: true },
      schema: { is_nullable: true },
    });
    await directus.ensureField({
      field: 'payment_method',
      type: 'string',
      meta: { interface: 'input', note: 'Mock payment channel chosen by the applicant (e-payment / e-wallet / Apple Pay / Samsung Pay).', hidden: true },
      schema: { is_nullable: true },
    });
    await directus.ensureField({
      field: 'license_issued_at',
      type: 'timestamp',
      meta: { interface: 'datetime', note: 'When the cinema film screening license was issued.', hidden: true },
      schema: { is_nullable: true },
    });
    await directus.ensureField({
      field: 'applicant_notified',
      type: 'boolean',
      meta: { interface: 'boolean', note: 'Mock e-services notification flag after license issuance.', hidden: true, options: { label: 'Applicant notified' } },
      schema: { is_nullable: true, default_value: false },
    });
    await directus.ensureField({
      field: 'notification_message',
      type: 'text',
      meta: { interface: 'input-multiline', note: 'Mock notification body shown in the applicant portal after license issuance.', hidden: true },
      schema: { is_nullable: true },
    });
    await directus.ensureStatusChoice('revision_requested', 'Revision Requested');
    await directus.ensureStatusChoice('completed', 'Completed');
    console.log('[startup] support fields verified (eligible, review_comments, field_visit_date, sla_breached, revision_loop_used, license_qr, payment_method, license notify fields, status:revision_requested, status:completed)');
  } catch (err) {
    console.error('[startup] provisioning failed:', err.message);
    return;
  }

  try {
    const canvas = processCanvas.loadCanvas(PROCESS_KEY);
    const { xml } = processCanvas.compileCanvas(canvas);
    const { version } = await camunda.deployProcessXml(PROCESS_KEY, xml, 'process-canvas');
    console.log(`[startup] process canvas "${PROCESS_KEY}" redeployed as version ${version}`);
  } catch (err) {
    console.error('[startup] process canvas redeploy failed:', err.message);
  }

  try {
    const pending = await directus.listApplicationsPendingEligibility();
    for (const app of pending) {
      const evaluated = await camunda.evaluateDecision('cinema_eligibility_and_fee', {
        validCommercialRegistration: !!app.valid_commercial_registration,
        validPriorPracticeLicense: !!app.valid_prior_practice_license,
        hasRiyadaCard: !!app.has_riyada_card,
      });
      if (evaluated) {
        await directus.updateApplication(app.id, { eligible: evaluated.eligible, final_fee: evaluated.finalFee });
      }
    }
    if (pending.length) console.log(`[startup] backfilled eligibility/fee on ${pending.length} existing application(s)`);
  } catch (err) {
    console.error('[startup] eligibility backfill failed:', err.message);
  }
}
