import { isCidShape, normalizeCid } from './cid.mjs';

export const TRAINING_RUN_MANIFEST_SCHEMA = 'https://api.murakumo.cloud/training/run-manifest/v1';
const CID_LIST_LIMIT = 1000;
const MANIFEST_CAP = 256 * 1024;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function text(value, field, max = 200) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value) {
    throw new Error(`${field} must be a trimmed string of 1..${max} characters`);
  }
  return value;
}

function cid(value, field) {
  if (!isCidShape(value)) throw new Error(`${field} must be a CIDv0 or CIDv1 Yataverse CID`);
  const canonical = normalizeCid(value);
  if (!canonical) throw new Error(`${field} must use a supported sha2-256 CID encoding`);
  return canonical;
}

function cidList(value, field) {
  if (!Array.isArray(value) || value.length < 1 || value.length > CID_LIST_LIMIT ||
      !value.every(isCidShape)) {
    throw new Error(`${field} must contain 1..${CID_LIST_LIMIT} Yataverse CIDs`);
  }
  return [...new Set(value.map((entry) => cid(entry, `${field} entry`)))].sort();
}

function validIsoUtcTimestamp(value, field) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) throw new Error(`${field} must be an ISO 8601 UTC timestamp`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1] &&
        hour <= 23 && minute <= 59 && second <= 59)) {
    throw new Error(`${field} must be a valid ISO 8601 UTC timestamp`);
  }
  return Date.parse(value);
}

function validDid(value) {
  return /^did:[a-z0-9]+:(?:(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})*:)*(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+$/.test(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (plainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

/**
 * Validate a privacy-conscious training-run provenance claim and return stable JSON.
 * The manifest is a claim bundle, not a signature or proof that the run occurred.
 */
export function canonicalTrainingRunManifest(input) {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MANIFEST_CAP) {
    throw new Error(`training-run manifest must be at most ${MANIFEST_CAP} UTF-8 bytes`);
  }
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  if (!plainObject(value)) throw new Error('training-run manifest must be a JSON object');
  const allowed = new Set(['schema', 'runId', 'epochId', 'startedAt', 'completedAt', 'inputCids',
    'modelCids', 'outputCids', 'trainingCodeCid', 'configCid', 'receiptCids', 'operatorDid',
    'claimStatus']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) {
    throw new Error(`unknown training-run manifest field: ${key}`);
  }
  if (value.schema !== TRAINING_RUN_MANIFEST_SCHEMA) {
    throw new Error(`schema must be ${TRAINING_RUN_MANIFEST_SCHEMA}`);
  }
  if (value.claimStatus !== undefined && value.claimStatus !== 'unverified') {
    throw new Error('claimStatus is fixed as unverified until Murakumo reviews the evidence');
  }

  const runId = text(value.runId, 'runId', 160);
  if (!/^[A-Za-z0-9._:-]+$/.test(runId)) throw new Error('runId contains unsupported characters');
  const epochId = text(value.epochId, 'epochId', 160);
  if (!/^[A-Za-z0-9._:-]+$/.test(epochId)) throw new Error('epochId contains unsupported characters');
  const startedAt = text(value.startedAt, 'startedAt', 40);
  const completedAt = text(value.completedAt, 'completedAt', 40);
  const startedMillis = validIsoUtcTimestamp(startedAt, 'startedAt');
  const completedMillis = validIsoUtcTimestamp(completedAt, 'completedAt');
  if (completedMillis < startedMillis) throw new Error('completedAt must be at or after startedAt');

  const operatorDid = text(value.operatorDid, 'operatorDid', 512);
  if (!validDid(operatorDid)) throw new Error('operatorDid must be a DID');
  const manifest = {
    schema: TRAINING_RUN_MANIFEST_SCHEMA,
    runId,
    epochId,
    startedAt,
    completedAt,
    inputCids: cidList(value.inputCids, 'inputCids'),
    modelCids: cidList(value.modelCids, 'modelCids'),
    outputCids: cidList(value.outputCids, 'outputCids'),
    trainingCodeCid: cid(value.trainingCodeCid, 'trainingCodeCid'),
    configCid: cid(value.configCid, 'configCid'),
    receiptCids: cidList(value.receiptCids, 'receiptCids'),
    operatorDid,
    claimStatus: 'unverified',
  };
  return JSON.stringify(canonical(manifest)) + '\n';
}
