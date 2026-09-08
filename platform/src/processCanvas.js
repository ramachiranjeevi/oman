// PowerPoint-style process designer: shapes dragged anywhere on a canvas,
// connected by drawn arrows. Compiles the resulting graph straight to BPMN
// using the user's own x/y positions for the diagram.
//
// Shape types (plain language, no BPMN vocabulary):
//   start      - exactly one, where the process begins
//   end        - one or more, where a path terminates
//   task       - a human does something (candidateGroup)
//   automatic  - the system does something (action, from a known list)
//   approval   - a human reviews; can have >1 outgoing connection, each
//                labeled (e.g. "Approve", "Comments", "Reject") — labels
//                become the value of the `outcome` process variable
//   decision   - a DMN rule check; exactly 2 outgoing connections, labeled
//                "Eligible" / "Not Eligible" by convention
//
// A shape with >1 outgoing connection gets an exclusiveGateway inserted
// automatically right after it — the user never places a gateway
// themselves, it's implied by "this box has more than one arrow out."

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'processCanvases.json');

function readAll() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
function writeAll(all) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}

export const AUTOMATIC_ACTIONS = [
  { value: 'auto-schedule-field-visit', label: 'Auto-schedule a field visit' },
  { value: 'escalate-sla-breach', label: 'Send an escalation notice' },
  { value: 'issue-license', label: 'Issue license, notify applicant & publish QR' },
];

// The real, currently-deployed shape of the cinema license process,
// expressed as a graph — seeds the canvas so editing starts from what's
// actually live.
const DEFAULT_CANVAS = {
  processKey: 'cinema_film_screening_license',
  processName: 'Cinema Film Screening License',
  shapes: [
    { id: 'start', type: 'start', name: 'Application Submitted', x: 40, y: 160 },
    { id: 'decision', type: 'decision', name: 'Eligibility Check', x: 200, y: 140, decisionKey: 'cinema_eligibility_and_fee', resultVar: 'eligibilityResult' },
    { id: 'notEligible', type: 'end', name: 'Rejected - Not Eligible', x: 260, y: 340 },
    { id: 'pay', type: 'task', name: 'Applicant Pays Fee', x: 420, y: 140, candidateGroup: 'applicant' },
    { id: 'schedule', type: 'automatic', name: 'Auto-schedule Field Visit', x: 600, y: 140, action: 'auto-schedule-field-visit' },
    { id: 'evaluate', type: 'task', name: 'Field Visit & Evaluation', x: 780, y: 140, candidateGroup: 'specialist' },
    {
      id: 'review', type: 'approval', name: 'Head of Section Review', x: 960, y: 140, candidateGroup: 'head_of_section',
      timer: { duration: 60, unit: 'minutes', onTimeoutAction: 'escalate-sla-breach' },
    },
    { id: 'rejected', type: 'end', name: 'Rejected', x: 1140, y: 340 },
    { id: 'issue', type: 'automatic', name: 'Issue License + QR', x: 1140, y: 140, action: 'issue-license' },
    { id: 'approved', type: 'end', name: 'License Issued', x: 1320, y: 140 },
  ],
  connections: [
    { id: 'c1', from: 'start', to: 'decision' },
    { id: 'c2', from: 'decision', to: 'pay', label: 'Eligible' },
    { id: 'c3', from: 'decision', to: 'notEligible', label: 'Not Eligible' },
    { id: 'c4', from: 'pay', to: 'schedule' },
    { id: 'c5', from: 'schedule', to: 'evaluate' },
    { id: 'c6', from: 'evaluate', to: 'review' },
    { id: 'c7', from: 'review', to: 'evaluate', label: 'Comments' },
    { id: 'c8', from: 'review', to: 'rejected', label: 'Reject' },
    { id: 'c9', from: 'review', to: 'issue', label: 'Approve' },
    { id: 'c10', from: 'issue', to: 'approved' },
  ],
};

export function loadCanvas(processKey) {
  const all = readAll();
  return all[processKey] ?? { ...DEFAULT_CANVAS, processKey };
}
export function saveCanvas(processKey, canvas) {
  const all = readAll();
  all[processKey] = { ...canvas, processKey };
  writeAll(all);
  return all[processKey];
}

function sanitizeId(id) { return `El_${String(id).replace(/[^a-zA-Z0-9_]/g, '')}`; }
function xmlEscape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function validate(canvas) {
  const errors = [];
  const shapes = canvas.shapes || [];
  const connections = canvas.connections || [];
  const starts = shapes.filter((s) => s.type === 'start');
  if (starts.length !== 1) errors.push('There must be exactly one Start shape.');
  if (shapes.filter((s) => s.type === 'end').length === 0) errors.push('There must be at least one End shape.');

  shapes.forEach((s) => {
    if (!s.name?.trim()) errors.push(`A ${s.type} shape needs a name.`);
    if (s.type === 'task' && !s.candidateGroup) errors.push(`"${s.name}" needs to say who performs it.`);
    if (s.type === 'approval' && !s.candidateGroup) errors.push(`"${s.name}" needs to say who approves it.`);
    if (s.type === 'automatic' && !AUTOMATIC_ACTIONS.some((a) => a.value === s.action)) errors.push(`"${s.name}" needs a valid automatic action.`);
    if (s.type === 'decision' && !s.decisionKey) errors.push(`"${s.name}" needs a rule (DMN key) to check.`);

    const outs = connections.filter((c) => c.from === s.id);
    if (s.type !== 'end' && outs.length === 0) errors.push(`"${s.name}" has no outgoing arrow.`);
    if (outs.length > 1 && outs.some((c) => !c.label?.trim())) errors.push(`"${s.name}" has more than one outgoing arrow — every arrow out of it needs a short label.`);
    if (s.type === 'decision' && outs.length !== 2) errors.push(`"${s.name}" (a rule check) needs exactly 2 outgoing arrows.`);
  });

  connections.forEach((c) => {
    if (!shapes.some((s) => s.id === c.from)) errors.push(`An arrow starts from a shape that no longer exists.`);
    if (!shapes.some((s) => s.id === c.to)) errors.push(`An arrow points to a shape that no longer exists.`);
  });

  return errors;
}

function conditionFor(sourceShape, label) {
  if (sourceShape.type === 'decision') {
    const isEligible = /^elig/i.test(label);
    return `${sourceShape.resultVar || 'result'}.eligible == ${isEligible ? 'true' : 'false'}`;
  }
  return `outcome == "${label.trim().toLowerCase()}"`;
}

export function compileCanvas(canvas) {
  const errors = validate(canvas);
  if (errors.length) {
    const err = new Error(errors.join(' '));
    err.validationErrors = errors;
    throw err;
  }

  const shapes = canvas.shapes;
  const connections = canvas.connections;
  const byId = Object.fromEntries(shapes.map((s) => [s.id, s]));
  const elements = [];
  // Flow XML strings for standalone (fixed-id) flows like timer branches —
  // kept separate from the counter-numbered `flowRecords` below so the DI
  // section (which needs to reference exact flow ids) only has to track
  // the numbered ones.
  const fixedFlows = [];
  const flowRecords = []; // { id, from, to, condition? } — single source of truth for both XML and DI

  shapes.forEach((s) => {
    const id = sanitizeId(s.id);
    const name = xmlEscape(s.name);
    if (s.type === 'start') elements.push(`<bpmn:startEvent id="${id}" name="${name}" />`);
    else if (s.type === 'end') elements.push(`<bpmn:endEvent id="${id}" name="${name}" />`);
    else if (s.type === 'task') elements.push(`<bpmn:userTask id="${id}" name="${name}" camunda:candidateGroups="${xmlEscape(s.candidateGroup)}" />`);
    else if (s.type === 'automatic') elements.push(`<bpmn:serviceTask id="${id}" name="${name}" camunda:type="external" camunda:topic="${xmlEscape(s.action)}" />`);
    else if (s.type === 'decision') elements.push(`<bpmn:businessRuleTask id="${id}" name="${name}" camunda:decisionRef="${xmlEscape(s.decisionKey)}" camunda:mapDecisionResult="singleResult" camunda:resultVariable="${xmlEscape(s.resultVar || 'result')}" />`);
    else if (s.type === 'approval') elements.push(`<bpmn:userTask id="${id}" name="${name}" camunda:candidateGroups="${xmlEscape(s.candidateGroup)}" />`);

    if (s.type === 'approval' && s.timer?.duration) {
      const unitCode = { minutes: 'M', hours: 'H', days: 'D' }[s.timer.unit] || 'M';
      const iso = unitCode === 'D' ? `P${s.timer.duration}D` : `PT${s.timer.duration}${unitCode}`;
      const boundaryId = `${id}_timer`;
      elements.push(`<bpmn:boundaryEvent id="${boundaryId}" name="Timeout" attachedToRef="${id}"><bpmn:timerEventDefinition><bpmn:timeDuration xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${iso}</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:boundaryEvent>`);
      const escId = `${id}_escalate`;
      elements.push(`<bpmn:serviceTask id="${escId}" name="Escalate" camunda:type="external" camunda:topic="${xmlEscape(s.timer.onTimeoutAction || 'escalate-sla-breach')}" />`);
      fixedFlows.push(`<bpmn:sequenceFlow id="${sanitizeId(s.id)}_timerflow" sourceRef="${boundaryId}" targetRef="${escId}" />`);
      const escEndId = `${id}_timer_end`;
      elements.push(`<bpmn:endEvent id="${escEndId}" name="Escalation Sent" />`);
      fixedFlows.push(`<bpmn:sequenceFlow id="${sanitizeId(s.id)}_timerend" sourceRef="${escId}" targetRef="${escEndId}" />`);
    }
  });

  let flowCounter = 0;
  const gatewayFor = {};
  shapes.forEach((s) => {
    const outs = connections.filter((c) => c.from === s.id);
    if (outs.length > 1) {
      const gwId = `${sanitizeId(s.id)}_gw`;
      elements.push(`<bpmn:exclusiveGateway id="${gwId}" name="?" />`);
      flowRecords.push({ id: `Flow_${++flowCounter}`, from: sanitizeId(s.id), to: gwId });
      gatewayFor[s.id] = gwId;
    }
  });

  connections.forEach((c) => {
    const source = byId[c.from];
    const fromEl = gatewayFor[c.from] || sanitizeId(c.from);
    const toEl = sanitizeId(c.to);
    const condition = gatewayFor[c.from] && c.label ? conditionFor(source, c.label) : undefined;
    // Carry the user's own drawn bend point through so the deployed
    // diagram's routing matches what was actually drawn on the canvas.
    flowRecords.push({ id: `Flow_${++flowCounter}`, from: fromEl, to: toEl, condition, bend: c.bend });
  });

  const flows = flowRecords.map((f) =>
    f.condition
      ? `<bpmn:sequenceFlow id="${f.id}" sourceRef="${f.from}" targetRef="${f.to}"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\${${f.condition}}</bpmn:conditionExpression></bpmn:sequenceFlow>`
      : `<bpmn:sequenceFlow id="${f.id}" sourceRef="${f.from}" targetRef="${f.to}" />`
  ).concat(fixedFlows);

  // Diagram: use the user's own drag positions directly — no auto-layout
  // needed, they already arranged it.
  const dims = (s) => (s.type === 'start' || s.type === 'end' ? { w: 36, h: 36 } : s.type === 'decision' ? { w: 50, h: 50 } : { w: 110, h: 80 });
  const nodePos = {};
  shapes.forEach((s) => {
    const { w, h } = dims(s);
    nodePos[sanitizeId(s.id)] = { x: s.x, y: s.y, w, h, cx: s.x + w / 2, cy: s.y + h / 2 };
  });
  Object.entries(gatewayFor).forEach(([shapeId, gwId]) => {
    const src = nodePos[sanitizeId(shapeId)];
    nodePos[gwId] = { x: src.x + 140, y: src.cy - 25, w: 50, h: 50, cx: src.x + 165, cy: src.cy };
  });
  shapes.forEach((s) => {
    if (s.type === 'approval' && s.timer?.duration) {
      const id = sanitizeId(s.id);
      const host = nodePos[id];
      nodePos[`${id}_timer`] = { x: host.x + host.w - 46, y: host.y + host.h - 18, w: 36, h: 36, cx: host.x + host.w - 28, cy: host.y + host.h };
      nodePos[`${id}_escalate`] = { x: host.x, y: host.y + 200, w: 110, h: 80, cx: host.x + 55, cy: host.y + 240 };
      nodePos[`${id}_timer_end`] = { x: host.x + 130, y: host.y + 222, w: 36, h: 36, cx: host.x + 148, cy: host.y + 240 };
    }
  });

  const shapeDi = Object.entries(nodePos).map(([id, n]) =>
    `      <bpmndi:BPMNShape id="${id}_di" bpmnElement="${id}"><dc:Bounds x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" /></bpmndi:BPMNShape>`
  ).join('\n');

  // Every DI edge references a flow id straight out of flowRecords — the
  // exact same list that generated the XML flows above — so the two can
  // never drift out of sync.
  const edgeDi = flowRecords.map((f) => {
    const a = nodePos[f.from], b = nodePos[f.to];
    if (!a || !b) return null;
    const mid = f.bend ? `<di:waypoint x="${f.bend.x}" y="${f.bend.y}" />` : '';
    return `      <bpmndi:BPMNEdge id="${f.id}_di" bpmnElement="${f.id}"><di:waypoint x="${a.cx}" y="${a.cy}" />${mid}<di:waypoint x="${b.cx}" y="${b.cy}" /></bpmndi:BPMNEdge>`;
  }).filter(Boolean);

  const diagram = `\n  <bpmndi:BPMNDiagram id="BPMNDiagram_1">\n    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="${xmlEscape(canvas.processKey)}">\n${shapeDi}\n${edgeDi.join('\n')}\n    </bpmndi:BPMNPlane>\n  </bpmndi:BPMNDiagram>\n`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                   xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                   xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                   xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                   xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                   id="Definitions_${sanitizeId(canvas.processKey)}" targetNamespace="http://oman-info.gov.om/bpmn">

  <bpmn:process id="${xmlEscape(canvas.processKey)}" name="${xmlEscape(canvas.processName)}" isExecutable="true" camunda:historyTimeToLive="180">
${elements.map((e) => `    ${e}`).join('\n')}
${flows.map((e) => `    ${e}`).join('\n')}
  </bpmn:process>
${diagram}</bpmn:definitions>
`;

  return { xml, gatewayFor };
}
