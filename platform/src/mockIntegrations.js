// Simulated external system calls for Phase 3 (Integration) of the demo
// script: the Oman Business Platform (Commercial Registration validity) and
// ROP's Civil Status system (applicant personal data) are not available in
// this sandbox, so these are deterministic mocks — no network calls made.
// Every response is explicitly tagged `simulated: true` and carries a
// `source` label so the UI can disclose this clearly, per the RFP's
// requirement that simulated steps never be presented as live.

/** 12 demo citizens — civil IDs ending in 0 / specific “no-record” IDs return none. */
const MOCK_CITIZENS = [
  { name: 'Ahmed Al-Balushi', nationality: 'Omani', wilayat: 'Muscat' },
  { name: 'Fatima Al-Habsi', nationality: 'Omani', wilayat: 'Seeb' },
  { name: 'Said Al-Rawahi', nationality: 'Omani', wilayat: 'Nizwa' },
  { name: 'Mariam Al-Kindi', nationality: 'Omani', wilayat: 'Sohar' },
  { name: 'Khalid Al-Harthy', nationality: 'Omani', wilayat: 'Salalah' },
  { name: 'Noor Al-Zadjali', nationality: 'Omani', wilayat: 'Barka' },
  { name: 'Yousuf Al-Maamari', nationality: 'Omani', wilayat: 'Sur' },
  { name: 'Aisha Al-Riyami', nationality: 'Omani', wilayat: 'Ibri' },
  { name: 'Hassan Al-Shukaili', nationality: 'Omani', wilayat: 'Rustaq' },
  { name: 'Laila Al-Farsi', nationality: 'Omani', wilayat: 'Khasab' },
  { name: 'Omar Al-Ghafri', nationality: 'Omani', wilayat: 'Ibra' },
  { name: 'Sara Al-Amri', nationality: 'Omani', wilayat: 'Bahla' },
];

const MOCK_BUSINESSES = [
  'Cinema & Media Est.',
  'Gulf Screen Productions LLC',
  'Al Hajar Film House',
  'Oasis Picture Company',
  'Muscat Movie Traders',
  'Dhofar Screening Services',
  'Batinah Visual Arts Co.',
  'Qurm Entertainment LLC',
  'Sohar Digital Cinema',
  'Salalah Film Partners',
  'Nizwa Heritage Screens',
  'Sur Coastal Media Est.',
];

/** Civil IDs with no ROP record in this simulation (format may still be valid). */
const CIVIL_NO_RECORD = new Set([
  '12345678', // common demo “not found”
  '00000000',
  '11111111',
  '99999999',
]);

/** CR numbers with no active registration in this simulation. */
const CR_NO_RECORD = new Set([
  '1234568', // common demo “not found”
  '0000000',
  '1111111',
  '9999999',
]);

function isSevenDigits(v) {
  return /^\d{7}$/.test(String(v || '').trim());
}

function isEightDigits(v) {
  return /^\d{8}$/.test(String(v || '').trim());
}

function pickIndex(digits, size) {
  // Stable variety across different IDs (not just last digit).
  let h = 0;
  for (let i = 0; i < digits.length; i++) h = (h * 31 + Number(digits[i])) % 2147483647;
  return h % size;
}

export function lookupCommercialRegistration(crNumber) {
  const digits = String(crNumber || '').trim();
  const formatOk = isSevenDigits(digits);
  const listedMissing = CR_NO_RECORD.has(digits);
  // Also treat CRs ending in 000 as inactive (extra demo miss cases).
  const endsInactive = formatOk && digits.endsWith('000');
  const valid = formatOk && !listedMissing && !endsInactive;
  const biz = valid ? MOCK_BUSINESSES[pickIndex(digits, MOCK_BUSINESSES.length)] : null;

  let message;
  if (!formatOk) {
    message = 'No active Commercial Registration found for this number (must be 7 digits for this simulation).';
  } else if (!valid) {
    message = 'No active Commercial Registration found for this number.';
  } else {
    message = `Commercial Registration is active${biz ? ` — ${biz}` : ''}.`;
  }

  return {
    simulated: true,
    source: 'Oman Business Platform (SIMULATED)',
    crNumber: digits,
    valid,
    businessName: valid && biz ? `${biz} (${digits.slice(0, 3)})` : null,
    message,
  };
}

export function lookupCivilStatus(civilId) {
  const digits = String(civilId || '').trim();
  const formatOk = isEightDigits(digits);
  // No record: listed IDs, or last digit 0 (demo “citizen not found”).
  const noRecord = !formatOk || CIVIL_NO_RECORD.has(digits) || digits.endsWith('0');
  const citizen = !noRecord ? MOCK_CITIZENS[pickIndex(digits, MOCK_CITIZENS.length)] : null;

  let message;
  if (!formatOk) {
    message = 'No civil record found (must be 8 digits for this simulation).';
  } else if (!citizen) {
    message = 'No civil record found for this Civil ID.';
  } else {
    message = `Applicant record found. Name: ${citizen.name}`;
  }

  return {
    simulated: true,
    source: 'ROP Civil Status System (SIMULATED)',
    civilId: digits,
    valid: !!citizen,
    applicantName: citizen?.name ?? null,
    nationality: citizen?.nationality ?? null,
    wilayat: citizen?.wilayat ?? null,
    message,
  };
}

export function lookupPracticeLicense(civilId) {
  const digits = String(civilId || '').trim();
  const formatOk = isEightDigits(digits);
  // License on file when civil record exists and last digit is even (and not 0).
  const last = formatOk ? Number(digits[digits.length - 1]) : -1;
  const found = formatOk && !CIVIL_NO_RECORD.has(digits) && last > 0 && last % 2 === 0;
  return {
    simulated: true,
    source: 'Internal Lookup — Cinema Screening Practice License Register (SIMULATED)',
    civilId: digits,
    hasValidLicense: found,
    licenseNumber: found ? `CSPL-${digits.slice(-5)}` : null,
    message: found
      ? 'Existing valid Cinema Screening Practice License found.'
      : 'No existing practice license on file for this Civil ID.',
  };
}
