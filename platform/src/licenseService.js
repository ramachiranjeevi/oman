import * as directus from './directusClient.js';

/**
 * Mock e-services license issuance: write QR payload, mark application
 * completed, and "notify" the applicant (persisted message for the portal).
 */
export async function issueLicenseAndNotify(applicationId, { skipIfHasQr = false } = {}) {
  if (!applicationId) return {};

  if (skipIfHasQr) {
    const existing = await directus.getApplication(applicationId).catch(() => null);
    if (existing?.license_qr) {
      const update = {
        status: 'completed',
        license_qr: existing.license_qr,
        applicant_notified: true,
        notification_message:
          existing.notification_message
          || 'Your Cinema Film Screening License has been issued and is available for retrieval via the e-services portal.',
      };
      if (existing.status !== 'completed' || !existing.applicant_notified) {
        await directus.updateApplication(applicationId, update);
      }
      return update;
    }
  }

  const qr = `CFS-LIC-${applicationId}-${Date.now()}`;
  const notification_message =
    'Your Cinema Film Screening License has been issued. It is available for retrieval via the e-services portal with the QR code shown on your applications list.';
  const update = {
    status: 'completed',
    license_qr: qr,
    license_issued_at: new Date().toISOString(),
    applicant_notified: true,
    notification_message,
  };
  await directus.updateApplication(applicationId, update);
  console.log(`[license] issued ${qr} for application #${applicationId}; applicant notified (mock e-services)`);
  return update;
}
