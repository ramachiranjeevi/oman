import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as directus from './directusClient.js';
import * as camunda from './camundaClient.js';
import { startExternalTaskWorker } from './externalTaskWorker.js';
import * as platformConfig from './config.js';
import * as mockIntegrations from './mockIntegrations.js';
import * as pipelineLog from './pipelineLog.js';
import * as processCanvas from './processCanvas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const PROCESS_KEY = 'cinema_film_screening_license';

// --- Applications (Directus-backed) -----------------------------------

app.post('/api/applications', async (req, res) => {
  try {
    const record = await directus.createApplication({
      status: 'submitted',
      ...req.body,
    });
    const eligibilityInputs = {
      validCommercialRegistration: !!req.body.valid_commercial_registration,
      validPriorPracticeLicense: !!req.body.valid_prior_practice_license,
      hasRiyadaCard: !!req.body.has_riyada_card,
    };
    await camunda.startProcess(PROCESS_KEY, record.id, {
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
    res.status(201).json(record);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/applications', async (_req, res) => {
  try {
    res.json(await directus.listApplications());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/applications/:id', async (req, res) => {
  try {
    const record = await directus.getApplication(req.params.id);
    const process = await camunda.getProcessInstanceByBusinessKey(PROCESS_KEY, req.params.id);
    res.json({ ...record, processInstanceId: process?.id ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    const group = req.query.group || 'specialist';
    res.json(await camunda.listTasksForGroup(group));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/complete', async (req, res) => {
  try {
    const { variables, applicationId, applicationUpdate } = req.body;
    await camunda.completeTask(req.params.id, variables || {});
    if (applicationId && applicationUpdate) {
      await directus.updateApplication(applicationId, applicationUpdate);
    }
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/form-schema/:collection', async (req, res) => {
  try {
    res.json(await directus.getFormSchema(req.params.collection));
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

const FIELD_TYPE_PRESETS = {
  text: { type: 'string', interface: 'input' },
  longtext: { type: 'text', interface: 'input-multiline' },
  number: { type: 'float', interface: 'input' },
  boolean: { type: 'boolean', interface: 'boolean' },
};

app.post('/api/admin/fields', async (req, res) => {
  try {
    const { field, label, kind } = req.body;
    if (!field || !/^[a-z][a-z0-9_]*$/.test(field)) {
      return res.status(400).json({ error: 'field key must be snake_case, e.g. accessibility_requirements' });
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

app.post('/api/admin/process-canvas/:key/preview', (req, res) => {
  try {
    const canvas = { ...req.body, processKey: req.params.key };
    processCanvas.compileAndValidate(canvas); // throws on invalid; success just needs to not throw
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, validationErrors: err.validationErrors ?? [err.message] });
  }
});

app.post('/api/admin/process-canvas/:key', async (req, res) => {
  try {
    const canvas = { ...req.body, processKey: req.params.key };
    const { xml } = processCanvas.compileAndValidate(canvas);
    const saved = processCanvas.saveCanvas(req.params.key, canvas);
    const { version } = await camunda.deployProcessXml(req.params.key, xml, 'process-canvas');
    res.json({ ok: true, canvas: saved, version });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, validationErrors: err.validationErrors ?? [err.message] });
  }
});

// --- Advanced Editor: raw BPMN XML in/out for the embedded bpmn-js editor -
// Same deploy mechanism as everything else, just no compiler in between —
// this is for whoever actually knows BPMN and wants the real editing
// surface instead of the plain-language canvas.

app.get('/api/admin/process-xml/:key', async (req, res) => {
  try {
    res.json({ xml: await camunda.getProcessXml(req.params.key) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/process-xml/:key', async (req, res) => {
  try {
    const xml = req.body.xml || '';
    const looksLikeBpmn = xml.includes('<bpmn:definitions') || xml.includes('<definitions');
    if (!looksLikeBpmn) {
      return res.status(400).json({ error: 'No valid BPMN XML provided.' });
    }
    const { version } = await camunda.deployProcessXml(req.params.key, xml, 'advanced-editor');
    res.json({ ok: true, version });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
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

app.get('/api/dashboard/metrics', async (_req, res) => {
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
      meta: { interface: 'input', note: 'QR payload set when the license is issued.' },
      schema: { is_nullable: true },
    });
    await directus.ensureStatusChoice('revision_requested', 'Revision Requested');
    console.log('[startup] support fields verified (eligible, review_comments, field_visit_date, sla_breached, revision_loop_used, license_qr, status:revision_requested)');
  } catch (err) {
    console.error('[startup] provisioning failed:', err.message);
    return;
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
