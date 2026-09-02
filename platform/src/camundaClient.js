import 'dotenv/config';

const CAMUNDA_URL = process.env.CAMUNDA_URL;

async function camundaFetch(path, options = {}) {
  const res = await fetch(`${CAMUNDA_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Camunda ${options.method || 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

export async function startProcess(processKey, businessKey, variables = {}) {
  const camundaVars = Object.fromEntries(
    Object.entries(variables).map(([k, v]) => [k, { value: v }])
  );
  return camundaFetch(`/process-definition/key/${processKey}/start`, {
    method: 'POST',
    body: JSON.stringify({ businessKey: String(businessKey), variables: camundaVars }),
  });
}

export async function listTasksForGroup(candidateGroup) {
  const tasks = await camundaFetch(`/task?candidateGroup=${encodeURIComponent(candidateGroup)}`);
  const instanceIds = [...new Set(tasks.map((t) => t.processInstanceId).filter(Boolean))];
  const instances = await Promise.all(
    instanceIds.map((id) => camundaFetch(`/process-instance/${id}`).catch(() => null))
  );
  const businessKeyByInstance = Object.fromEntries(
    instances.filter(Boolean).map((i) => [i.id, i.businessKey])
  );
  return tasks.map((t) => ({ ...t, businessKey: businessKeyByInstance[t.processInstanceId] ?? null }));
}

export async function getTask(taskId) {
  return camundaFetch(`/task/${taskId}`);
}

export async function completeTask(taskId, variables = {}) {
  const camundaVars = Object.fromEntries(
    Object.entries(variables).map(([k, v]) => [k, { value: v }])
  );
  return camundaFetch(`/task/${taskId}/complete`, {
    method: 'POST',
    body: JSON.stringify({ variables: camundaVars }),
  });
}

// After completing a task, this tells us whether the token is still
// somewhere in the process (more steps ahead) or the instance just ended —
// Camunda 404s a process-instance id the moment it completes.
export async function isProcessInstanceActive(processInstanceId) {
  const res = await fetch(`${CAMUNDA_URL}/process-instance/${processInstanceId}`);
  return res.ok;
}

export async function getProcessInstanceByBusinessKey(processKey, businessKey) {
  const results = await camundaFetch(
    `/process-instance?processDefinitionKey=${processKey}&businessKey=${encodeURIComponent(businessKey)}`
  );
  return results[0] || null;
}

export async function countTasksForGroup(candidateGroup) {
  const { count } = await camundaFetch(`/task/count?candidateGroup=${encodeURIComponent(candidateGroup)}`);
  return count;
}

// --- DMN decision evaluation (eligibility + fee) ---------------------------

const PRICING_DECISION_KEY = 'cinema_eligibility_and_fee';

function unwrapResult(rawResultRow) {
  return Object.fromEntries(Object.entries(rawResultRow).map(([k, v]) => [k, v.value]));
}

export async function evaluateDecision(decisionKey, variables = {}) {
  const camundaVars = Object.fromEntries(
    Object.entries(variables).map(([k, v]) => [k, { value: v }])
  );
  const results = await camundaFetch(`/decision-definition/key/${decisionKey}/evaluate`, {
    method: 'POST',
    body: JSON.stringify({ variables: camundaVars }),
  });
  return results.map(unwrapResult)[0] ?? null;
}

// --- Live pricing + eligibility rule, backed by the deployed DMN -----------
// Both the fee logic and the eligibility conditions live in the same DMN
// decision table. Rather than patching individual cells with regex (fragile
// once the rule count changes — e.g. turning a requirement off removes a
// whole row), we read the table's current state, merge in the requested
// change, and regenerate the whole table from a small template. Read/write
// goes through Camunda's own REST API only — never the camunda-module's
// filesystem — keeping the module boundary (REST-only) intact.

function readOutputValue(xml, candidateIds) {
  for (const id of candidateIds) {
    const match = xml.match(new RegExp(`<outputEntry id="${id}">\\s*<text>([^<]*)</text>`));
    if (match) return Number(match[1]);
  }
  return null;
}

// A rule's "requirement" is inferred from whether its dedicated
// not-eligible row is present in the deployed table — no separate config
// store needed. Recognizes both the hand-authored original file's rule ids
// and this generator's own ids, so it works against whatever is currently
// deployed.
function readRequirement(xml, ruleIds) {
  return ruleIds.some((id) => xml.includes(`<rule id="${id}">`));
}

async function getDeployedDmnXml() {
  const { dmnXml } = await camundaFetch(`/decision-definition/key/${PRICING_DECISION_KEY}/xml`);
  return dmnXml;
}

async function getDecisionState() {
  const xml = await getDeployedDmnXml();
  return {
    baseFee: readOutputValue(xml, ['OutSme_BaseFee', 'Out_3_2']),
    smeDiscountPct: readOutputValue(xml, ['OutSme_DiscountPct', 'Out_3_3']),
    smeFinalFee: readOutputValue(xml, ['OutSme_FinalFee', 'Out_3_4']),
    standardFinalFee: readOutputValue(xml, ['OutStd_FinalFee', 'Out_4_4']),
    requireCommercialRegistration: readRequirement(xml, ['Rule_NotEligible_CR', 'Rule_NotEligible']),
    requirePriorPracticeLicense: readRequirement(xml, ['Rule_NotEligible_PriorLicense', 'Rule_NotEligible2']),
  };
}

function buildRuleXml({ id, cr, prior, riyada, eligible, baseFee, discountPct, finalFee, outPrefix }) {
  return `
      <rule id="${id}">
        <inputEntry id="${id}_In1"><text>${cr}</text></inputEntry>
        <inputEntry id="${id}_In2"><text>${prior}</text></inputEntry>
        <inputEntry id="${id}_In3"><text>${riyada}</text></inputEntry>
        <outputEntry id="${outPrefix}_Eligible"><text>${eligible}</text></outputEntry>
        <outputEntry id="${outPrefix}_BaseFee"><text>${baseFee}</text></outputEntry>
        <outputEntry id="${outPrefix}_DiscountPct"><text>${discountPct}</text></outputEntry>
        <outputEntry id="${outPrefix}_FinalFee"><text>${finalFee}</text></outputEntry>
      </rule>`;
}

function buildDecisionXml({ baseFee, smeDiscountPct, requireCommercialRegistration, requirePriorPracticeLicense }) {
  const smeFinalFee = Math.round(baseFee * (1 - smeDiscountPct / 100) * 100) / 100;
  const standardFinalFee = baseFee;
  const cr = requireCommercialRegistration ? 'true' : '-';
  const prior = requirePriorPracticeLicense ? 'true' : '-';

  const rules = [];
  if (requireCommercialRegistration) {
    rules.push(buildRuleXml({ id: 'Rule_NotEligible_CR', cr: 'false', prior: '-', riyada: '-', eligible: 'false', baseFee: 0, discountPct: 0, finalFee: 0, outPrefix: 'OutNotEligCr' }));
  }
  if (requirePriorPracticeLicense) {
    rules.push(buildRuleXml({ id: 'Rule_NotEligible_PriorLicense', cr: '-', prior: 'false', riyada: '-', eligible: 'false', baseFee: 0, discountPct: 0, finalFee: 0, outPrefix: 'OutNotEligPrior' }));
  }
  rules.push(buildRuleXml({ id: 'Rule_EligibleSme', cr, prior, riyada: 'true', eligible: 'true', baseFee, discountPct: smeDiscountPct, finalFee: smeFinalFee, outPrefix: 'OutSme' }));
  rules.push(buildRuleXml({ id: 'Rule_EligibleStandard', cr, prior, riyada: 'false', eligible: 'true', baseFee, discountPct: 0, finalFee: standardFinalFee, outPrefix: 'OutStd' }));

  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/"
             xmlns:camunda="http://camunda.org/schema/1.0/dmn"
             id="Definitions_eligibility" name="Cinema Eligibility and Fee" namespace="http://oman-info.gov.om/dmn">

  <decision id="cinema_eligibility_and_fee" name="Cinema Eligibility and Fee" camunda:historyTimeToLive="180">
    <decisionTable id="DecisionTable_1" hitPolicy="FIRST">
      <input id="Input_ValidCR" label="Valid Commercial Registration">
        <inputExpression id="InputExpr_1" typeRef="boolean"><text>validCommercialRegistration</text></inputExpression>
      </input>
      <input id="Input_ValidPriorLicense" label="Valid Prior Practice License">
        <inputExpression id="InputExpr_2" typeRef="boolean"><text>validPriorPracticeLicense</text></inputExpression>
      </input>
      <input id="Input_HasRiyada" label="Holds Riyada (SME) Card">
        <inputExpression id="InputExpr_3" typeRef="boolean"><text>hasRiyadaCard</text></inputExpression>
      </input>

      <output id="Output_Eligible" label="Eligible" name="eligible" typeRef="boolean" />
      <output id="Output_BaseFee" label="Base Fee (OMR)" name="baseFee" typeRef="double" />
      <output id="Output_DiscountPct" label="Discount %" name="discountPct" typeRef="double" />
      <output id="Output_FinalFee" label="Final Fee (OMR)" name="finalFee" typeRef="double" />
${rules.join('\n')}
    </decisionTable>
  </decision>
</definitions>
`;
}

async function deployResource(filename, xml, deploymentNamePrefix) {
  const form = new FormData();
  form.append('deployment-name', `${deploymentNamePrefix}-${Date.now()}`);
  form.append('deployment-source', 'platform-admin-panel');
  form.append('enable-duplicate-filtering', 'false');
  form.append(filename, new Blob([xml], { type: 'text/xml' }), filename);
  const res = await fetch(`${CAMUNDA_URL}/deployment/create`, { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error(`Camunda deployment/create failed: ${res.status} ${await res.text()}`);
  }
}

const deployDecisionXml = (xml, prefix) => deployResource('cinema_eligibility_and_fee.dmn', xml, prefix);

// Generic BPMN deploy used by the process designer — any process key/xml.
export async function deployProcessXml(processKey, xml, prefix = 'process-designer') {
  await deployResource(`${processKey}.bpmn`, xml, prefix);
  const rows = await camundaFetch(`/process-definition?key=${encodeURIComponent(processKey)}&sortBy=version&sortOrder=desc&maxResults=1`);
  return { version: rows[0]?.version ?? null };
}

export async function getPricing() {
  const { baseFee, smeDiscountPct, smeFinalFee, standardFinalFee } = await getDecisionState();
  return { baseFee, smeDiscountPct, smeFinalFee, standardFinalFee };
}

export async function updatePricing({ baseFee, smeDiscountPct }) {
  const current = await getDecisionState();
  const next = { ...current, baseFee, smeDiscountPct };
  await deployDecisionXml(buildDecisionXml(next), 'admin-pricing-update');
  const smeFinalFee = Math.round(baseFee * (1 - smeDiscountPct / 100) * 100) / 100;
  return { baseFee, smeDiscountPct, smeFinalFee, standardFinalFee: baseFee };
}

export async function getEligibilityRule() {
  const { requireCommercialRegistration, requirePriorPracticeLicense } = await getDecisionState();
  return { requireCommercialRegistration, requirePriorPracticeLicense };
}

export async function updateEligibilityRule({ requireCommercialRegistration, requirePriorPracticeLicense }) {
  const current = await getDecisionState();
  const next = { ...current, requireCommercialRegistration, requirePriorPracticeLicense };
  await deployDecisionXml(buildDecisionXml(next), 'admin-eligibility-update');
  return { requireCommercialRegistration, requirePriorPracticeLicense };
}

// --- Live SLA threshold, backed by the deployed BPMN ------------------------
// The Head of Section Review has a boundary timer (Gateway_/BoundaryEvent_SlaTimer)
// whose duration we read/rewrite directly in the deployed process XML, same
// REST-only pattern as the DMN above.

const PROCESS_KEY = 'cinema_film_screening_license';

function isoDurationToMinutes(iso) {
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const mins = Number(match[2] || 0);
  return hours * 60 + mins;
}

function minutesToIsoDuration(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours === 0) return `PT${mins || 0}M`;
  return mins === 0 ? `PT${hours}H` : `PT${hours}H${mins}M`;
}

export async function getSlaMinutes() {
  const { bpmn20Xml } = await camundaFetch(`/process-definition/key/${PROCESS_KEY}/xml`);
  const match = bpmn20Xml.match(/<bpmn:timeDuration[^>]*>([^<]*)<\/bpmn:timeDuration>/);
  return match ? isoDurationToMinutes(match[1]) : null;
}

export async function updateSlaMinutes(minutes) {
  const { bpmn20Xml } = await camundaFetch(`/process-definition/key/${PROCESS_KEY}/xml`);
  const updated = bpmn20Xml.replace(
    /(<bpmn:timeDuration[^>]*>)[^<]*(<\/bpmn:timeDuration>)/,
    `$1${minutesToIsoDuration(minutes)}$2`
  );
  await deployResource('cinema_film_screening_license.bpmn', updated, 'admin-sla-update');
  return { slaMinutes: minutes };
}

// --- History (for SLA measurement) ------------------------------------------

export async function getFinishedTasks(taskDefinitionKey, finishedAfterIso) {
  // Camunda 7's REST date params want `+0000`-style offsets, not `Z`.
  const camundaDate = finishedAfterIso ? finishedAfterIso.replace('Z', '+0000') : null;
  const after = camundaDate ? `&finishedAfter=${encodeURIComponent(camundaDate)}` : '';
  return camundaFetch(
    `/history/task?taskDefinitionKey=${encodeURIComponent(taskDefinitionKey)}&finished=true&maxResults=1000${after}`
  );
}
