// Simulated external system calls for Phase 3 (Integration) of the demo
// script: the Oman Business Platform (Commercial Registration validity) and
// ROP's Civil Status system (applicant personal data) are not available in
// this sandbox, so these are deterministic mocks — no network calls made.
// Every response is explicitly tagged `simulated: true` and carries a
// `source` label so the UI can disclose this clearly, per the RFP's
// requirement that simulated steps never be presented as live.

const MOCK_NAMES = ['Ahmed Al-Balushi', 'Fatima Al-Habsi', 'Said Al-Rawahi', 'Mariam Al-Kindi', 'Khalid Al-Harthy'];

export function lookupCommercialRegistration(crNumber) {
  const valid = /^\d{7}$/.test(String(crNumber || '').trim());
  return {
    simulated: true,
    source: 'Oman Business Platform (SIMULATED)',
    crNumber,
    valid,
    businessName: valid ? `Cinema & Media Est. ${crNumber.slice(0, 3)}` : null,
    message: valid ? 'Commercial Registration is active.' : 'No active Commercial Registration found for this number (must be 7 digits for this simulation).',
  };
}

export function lookupCivilStatus(civilId) {
  const digits = String(civilId || '').trim();
  const valid = /^\d{8}$/.test(digits);
  const name = valid ? MOCK_NAMES[Number(digits) % MOCK_NAMES.length] : null;
  return {
    simulated: true,
    source: "ROP Civil Status System (SIMULATED)",
    civilId,
    valid,
    applicantName: name,
    nationality: valid ? 'Omani' : null,
    message: valid ? 'Applicant record found.' : 'No civil record found (must be 8 digits for this simulation).',
  };
}

export function lookupPracticeLicense(civilId) {
  const digits = String(civilId || '').trim();
  const found = /^\d{8}$/.test(digits) && Number(digits[digits.length - 1]) % 2 === 0;
  return {
    simulated: true,
    source: 'Internal Lookup — Cinema Screening Practice License Register (SIMULATED)',
    civilId,
    hasValidLicense: found,
    licenseNumber: found ? `CSPL-${digits.slice(-5)}` : null,
    message: found
      ? 'Existing valid Cinema Screening Practice License found.'
      : 'No existing practice license on file (this simulation: civil ID must end in an even digit).',
  };
}
