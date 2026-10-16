import { isCidShape, normalizeCid } from './cid.mjs';

export const ASSET_MANIFEST_SCHEMA = 'https://api.murakumo.cloud/training/asset-manifest/v1';
const TYPES = new Set(['dataset', 'model', 'checkpoint', 'adapter', 'evaluation']);
const LICENSES = new Set(['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'USER-TRAINING-GRANT-v1']);
const CLAIM_ROLES = new Set(['creator', 'data-provider', 'maintainer', 'model-trainer']);
const CID_LIST_LIMIT = 1000;
const CLAIM_LIMIT = 200;
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

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (plainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

/**
 * Validate a declarative, privacy-conscious asset manifest and return stable JSON.
 * The claims are not signatures or proof of copyright; Murakumo must review them.
 */
export function canonicalAssetManifest(input) {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MANIFEST_CAP) {
    throw new Error(`manifest must be at most ${MANIFEST_CAP} UTF-8 bytes`);
  }
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  if (!plainObject(value)) throw new Error('manifest must be a JSON object');
  const allowed = new Set(['schema', 'assetType', 'artifactCid', 'license', 'rightsEvidenceCid',
    'sourceCids', 'trainingRunIds', 'contributors', 'createdAt', 'claimStatus']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown manifest field: ${key}`);
  if (value.schema !== ASSET_MANIFEST_SCHEMA) throw new Error(`schema must be ${ASSET_MANIFEST_SCHEMA}`);
  if (value.claimStatus !== undefined && value.claimStatus !== 'unverified') {
    throw new Error('claimStatus is fixed as unverified until Murakumo reviews the claims');
  }

  const assetType = text(value.assetType, 'assetType', 32);
  if (!TYPES.has(assetType)) throw new Error(`assetType must be one of ${[...TYPES].join(', ')}`);
  const artifactCid = cid(value.artifactCid, 'artifactCid');
  const license = text(value.license, 'license', 80);
  if (!LICENSES.has(license)) throw new Error(`license must be one of ${[...LICENSES].join(', ')}`);
  const rightsEvidenceCid = cid(value.rightsEvidenceCid, 'rightsEvidenceCid');

  const sourceCids = value.sourceCids ?? [];
  if (!Array.isArray(sourceCids) || sourceCids.length > CID_LIST_LIMIT || !sourceCids.every(isCidShape)) {
    throw new Error(`sourceCids must be an array of at most ${CID_LIST_LIMIT} CIDv0 or CIDv1 values`);
  }
  const trainingRunIds = value.trainingRunIds ?? [];
  if (!Array.isArray(trainingRunIds) || trainingRunIds.length > CID_LIST_LIMIT ||
      !trainingRunIds.every((id) => typeof id === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(id))) {
    throw new Error(`trainingRunIds must be an array of at most ${CID_LIST_LIMIT} bounded identifiers`);
  }
  if (!Array.isArray(value.contributors) || value.contributors.length < 1 || value.contributors.length > CLAIM_LIMIT) {
    throw new Error(`contributors must contain 1..${CLAIM_LIMIT} claims`);
  }
  const seen = new Set();
  let shares = 0;
  const contributors = value.contributors.map((claim, index) => {
    if (!plainObject(claim)) throw new Error(`contributors[${index}] must be an object`);
    for (const key of Object.keys(claim)) {
      if (!['did', 'role', 'shareBps'].includes(key)) throw new Error(`unknown contributor field: ${key}`);
    }
    const did = text(claim.did, `contributors[${index}].did`, 512);
    if (!/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(did)) throw new Error(`contributors[${index}].did must be a DID`);
    if (seen.has(did)) throw new Error(`duplicate contributor DID: ${did}`);
    seen.add(did);
    const role = text(claim.role, `contributors[${index}].role`, 32);
    if (!CLAIM_ROLES.has(role)) throw new Error(`contributors[${index}].role must be one of ${[...CLAIM_ROLES].join(', ')}`);
    const shareBps = claim.shareBps;
    if (!Number.isInteger(shareBps) || shareBps < 1 || shareBps > 10000) {
      throw new Error(`contributors[${index}].shareBps must be an integer from 1 to 10000`);
    }
    shares += shareBps;
    return { did, role, shareBps };
  }).sort((a, b) => a.did.localeCompare(b.did));
  if (shares > 10000) throw new Error('contributor shareBps values must total at most 10000');

  const createdAt = value.createdAt === undefined ? undefined : text(value.createdAt, 'createdAt', 40);
  if (createdAt !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(createdAt)) {
    throw new Error('createdAt must be an ISO 8601 UTC timestamp');
  }

  const manifest = {
    schema: ASSET_MANIFEST_SCHEMA,
    assetType,
    artifactCid,
    license,
    rightsEvidenceCid,
    sourceCids: [...new Set(sourceCids.map((value) => cid(value, 'sourceCids entry')))].sort(),
    trainingRunIds: [...new Set(trainingRunIds)].sort(),
    contributors,
    claimStatus: 'unverified',
    ...(createdAt === undefined ? {} : { createdAt }),
  };
  return JSON.stringify(canonical(manifest)) + '\n';
}
