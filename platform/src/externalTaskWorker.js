import 'dotenv/config';
import * as directus from './directusClient.js';
import { getConfig } from './config.js';

const CAMUNDA_URL = process.env.CAMUNDA_URL;
const WORKER_ID = 'platform-worker';

async function fetchAndLock(topics) {
  const res = await fetch(`${CAMUNDA_URL}/external-task/fetchAndLock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workerId: WORKER_ID,
      maxTasks: 10,
      usePriority: false,
      topics: topics.map((topicName) => ({ topicName, lockDuration: 30000 })),
    }),
  });
  if (!res.ok) throw new Error(`fetchAndLock failed: ${res.status}`);
  return res.json();
}

async function complete(taskId, variables = {}) {
  const camundaVars = Object.fromEntries(
    Object.entries(variables).map(([k, v]) => [k, { value: v }])
  );
  const res = await fetch(`${CAMUNDA_URL}/external-task/${taskId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId: WORKER_ID, variables: camundaVars }),
  });
  if (!res.ok && res.status !== 204) {
    console.error(`complete ${taskId} failed: ${res.status} ${await res.text()}`);
  }
}

const handlers = {
  'auto-schedule-field-visit': async (task) => {
    const applicationId = task.variables.applicationId?.value;
    const leadDays = getConfig().fieldVisitLeadTimeDays;
    const visitDate = new Date(Date.now() + leadDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    console.log(`[worker] auto-scheduling field visit for application #${applicationId} on ${visitDate} (lead time: ${leadDays} day(s))`);
    if (applicationId) {
      await directus.updateApplication(applicationId, { status: 'field_visit_scheduled', field_visit_date: visitDate });
    }
    await complete(task.id, { fieldVisitDate: visitDate });
  },
  'escalate-sla-breach': async (task) => {
    const applicationId = task.variables.applicationId?.value;
    console.log(`[worker] SLA BREACH escalation for application #${applicationId} (Head of Section review overdue)`);
    if (applicationId) {
      await directus.updateApplication(applicationId, { sla_breached: true });
    }
    await complete(task.id, {});
  },
  'issue-license': async (task) => {
    const applicationId = task.variables.applicationId?.value;
    const qr = `LICENSE-${applicationId}-${Date.now()}`;
    console.log(`[worker] issuing license for application #${applicationId}, QR: ${qr}`);
    if (applicationId) {
      await directus.updateApplication(applicationId, { status: 'approved', license_qr: qr });
    }
    await complete(task.id, { licenseQr: qr });
  },
};

async function pollOnce() {
  const tasks = await fetchAndLock(Object.keys(handlers));
  for (const task of tasks) {
    const handler = handlers[task.topicName];
    if (handler) {
      try {
        await handler(task);
      } catch (err) {
        console.error(`[worker] error handling ${task.topicName}:`, err.message);
      }
    }
  }
}

export function startExternalTaskWorker(intervalMs = 2000) {
  console.log('[worker] external task worker started, polling every', intervalMs, 'ms');
  setInterval(() => {
    pollOnce().catch((err) => console.error('[worker] poll error:', err.message));
  }, intervalMs);
}
