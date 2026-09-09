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

function isSevenDigits(v) {
  return /^\d{7}$/.test(String(v || '').trim());
}

function isEightDigits(v) {
  return /^\d{8}$/.test(String(v || '').trim());
}

function isBlockedDemoNumber(digits) {
  return digits.startsWith('1');
}

function shouldFailCommercialRegistration(digits) {
  return isBlockedDemoNumber(digits) && Number(digits[digits.length - 1]) % 2 === 0;
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
  const valid = formatOk && !shouldFailCommercialRegistration(digits);
  const biz = valid ? MOCK_BUSINESSES[pickIndex(digits, MOCK_BUSINESSES.length)] : null;

  let message;
  if (!formatOk) {
    message = 'Commercial Registration number must contain 7 digits.';
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
  const noRecord = !formatOk;
  const citizen = !noRecord ? MOCK_CITIZENS[pickIndex(digits, MOCK_CITIZENS.length)] : null;

  let message;
  if (!formatOk) {
    message = 'Civil ID must contain 8 digits.';
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

export function lookupPracticeLicense(civilId, crNumber = '') {
  const digits = String(civilId || '').trim();
  const crDigits = String(crNumber || '').trim();
  const formatOk = isEightDigits(digits);
  const restrictedScenario = isBlockedDemoNumber(digits) || isBlockedDemoNumber(crDigits);
  // For numbers beginning with 1, exactly one business requirement fails:
  // an even-ending CR fails registration; otherwise the prior licence fails.
  const found = formatOk && (!restrictedScenario || shouldFailCommercialRegistration(crDigits));
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
