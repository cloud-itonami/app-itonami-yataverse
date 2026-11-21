// Yataverse retention lease and retention status v1 (docs/retention-design.md §4–§6, AWAI-3670).
// Types and verification only: nothing here talks to a store, a bucket or the network.
//
// - A lease is the unit of a retention promise. It is signed by the requester and by the verifier
//   that will judge it. Its id is the hash of the struct with leaseId set to zero, so the same
//   terms always give the same id.
// - A status is the verifier's short-lived statement about a lease. Only a status can say
//   "policy-satisfied"; a storage receipt never can (src/receipt.mjs rejects that).
//
// Both are EIP-712 typed data signed with Ed25519 over the EIP-712 digest, like storage receipts.
import crypto from 'node:crypto';
import { typedDataDigest, hashStruct, typeString } from './eip712.mjs';
import { encodeDagCbor, decodeDagCbor } from './dag-cbor.mjs';
import { cidFor, cidToBytes, CODEC_DAG_CBOR } from './cid.mjs';
import { keyIdFor, keyUses, KEY_USE, STORE_CLASS, ZERO32 } from './receipt.mjs';

export class RetentionError extends Error { constructor(code) { super(code); this.code = code; } }
const bad = (code) => { throw new RetentionError(code); };

export const LEASE_TYPE = 'YataverseRetentionLease';
export const LEASE_FIELDS = [
  ['leaseId', 'bytes32'], ['subject', 'bytes'], ['size', 'uint64'], ['pieceCommitment', 'bytes32'],
  ['grade', 'uint8'], ['providerReplicas', 'uint8'], ['domainPolicy', 'bytes32'], ['notBefore', 'uint64'],
  ['retentionUntil', 'uint64'], ['challengePeriod', 'uint32'], ['requester', 'bytes32'], ['verifier', 'bytes32'],
  ['policyRevision', 'bytes32'],
];
export const LEASE_DOMAIN = Object.freeze({ name: 'Awai Yataverse Retention Lease', version: '1' });
export const LEASE_TYPE_STRING = typeString(LEASE_TYPE, LEASE_FIELDS);

export const STATUS_TYPE = 'YataverseRetentionStatus';
export const STATUS_FIELDS = [
  ['leaseId', 'bytes32'], ['subject', 'bytes'], ['grade', 'uint8'], ['status', 'uint8'],
  ['providerReplicas', 'uint8'], ['operatorCopies', 'uint8'], ['evidenceRoot', 'bytes32'], ['observedAt', 'uint64'],
  ['validUntil', 'uint64'], ['keyId', 'bytes32'], ['keyEpoch', 'uint32'],
];
export const STATUS_DOMAIN = Object.freeze({ name: 'Awai Yataverse Retention Status', version: '1' });
export const STATUS_TYPE_STRING = typeString(STATUS_TYPE, STATUS_FIELDS);

/** Grades (design §3.2). R1: operator archive only. R2: operator archive and provider nodes. R3: provider nodes. */
export const GRADE = Object.freeze({ R1: 1, R2: 2, R3: 3 });
export const STATUS = Object.freeze({ policySatisfied: 10, degraded: 20, repairing: 21, expired: 30, released: 31 });
/** Owner decision 2026-11-21 (design §13, decision 3): R3 needs three independent provider replicas. */
export const R3_MIN_PROVIDER_REPLICAS = 3;
/** A status may be trusted for at most this many challenge periods after it was observed (design §6). */
export const STATUS_MAX_VALIDITY_PERIODS = 2;
/** How far in the future observedAt may be, to allow for clock differences. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_SUBJECT_BYTES = 128;

const sha256 = (b) => new Uint8Array(crypto.createHash('sha256').update(b).digest());
const toHex = (b) => '0x' + Buffer.from(b).toString('hex');
const b64url = (b) => Buffer.from(b).toString('base64url');
const subtle = () => globalThis.crypto?.subtle ?? crypto.webcrypto.subtle;
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const isZero = (b) => b.every((x) => x === 0);

// --- Field handling shared by both types ---

function checkAgainst(fields, what, r) {
  if (!r || typeof r !== 'object') bad(`${what}-not-an-object`);
  const keys = Object.keys(r);
  if (keys.length !== fields.length || fields.some(([n]) => !Object.hasOwn(r, n))) bad(`${what}-fields-do-not-match`);
  for (const [n, t] of fields) {
    const v = r[n];
    if (t === 'bytes32') { if (!(v instanceof Uint8Array) || v.length !== 32) bad(`bad-bytes32:${n}`); }
    else if (t === 'bytes') { if (!(v instanceof Uint8Array) || v.length === 0 || v.length > MAX_SUBJECT_BYTES) bad(`bad-bytes:${n}`); }
    else if (!Number.isSafeInteger(v) || v < 0 || BigInt(v) >= 1n << BigInt(Number(t.slice(4)))) bad(`bad-uint:${n}`);
  }
  return r;
}

function fromHex(s, field, len) {
  if (typeof s !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(s)) bad(`bad-hex:${field}`);
  const b = new Uint8Array(Buffer.from(s.slice(2), 'hex'));
  if (len !== undefined && b.length !== len) bad(`bad-length:${field}`);
  return b;
}

const fieldsToJson = (fields, r) => Object.fromEntries(fields.map(([n, t]) => [n, t.startsWith('uint') ? r[n] : toHex(r[n])]));

function fieldsFromJson(fields, j) {
  if (!j || typeof j !== 'object') bad('not-an-object');
  for (const k of Object.keys(j)) if (!fields.some(([n]) => n === k)) bad(`unknown-field:${k}`);
  return Object.fromEntries(fields.map(([n, t]) => [n, t.startsWith('uint') ? j[n] : fromHex(j[n], n, t === 'bytes32' ? 32 : undefined)]));
}

function fieldsFromCbor(m) {
  if (!(m instanceof Map)) bad('record-not-a-map');
  const out = {};
  for (const [k, x] of m) out[k] = typeof x === 'bigint' ? (x <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(x) : bad(`bad-uint:${k}`)) : x;
  return out;
}

function sigFromJson(s, keyField) {
  if (!s || typeof s.sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(s.sig)) bad('bad-signature-encoding');
  return { alg: s.alg, [keyField]: fromHex(s[keyField], `sig.${keyField}`, 32), sig: new Uint8Array(Buffer.from(s.sig, 'base64url')) };
}
const sigToJson = (s, keyField) => ({ alg: s.alg, [keyField]: toHex(s[keyField]), sig: b64url(s.sig) });

function checkSigShape(s, keyField) {
  if (!s) bad('signature-missing');
  if (s.alg !== 'Ed25519') bad('unsupported-signature-algorithm');
  if (!(s.sig instanceof Uint8Array) || s.sig.length !== 64) bad('bad-signature-length');
  if (!(s[keyField] instanceof Uint8Array) || s[keyField].length !== 32) bad('bad-signature-key');
}

async function verifyEd25519(publicKey, sig, digest) {
  const pub = await subtle().importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
  return subtle().verify('Ed25519', pub, sig, digest);
}

/**
 * Look up a verifier key in a published key set and check that it may act as a retention verifier
 * at time `at` (Unix ms). -> its 32-byte public key.
 */
function verifierKeyAt(keys, keyId, at, keyEpoch) {
  const entry = (keys?.keys ?? []).find((k) => k.keyId === toHex(keyId));
  if (!entry) bad('unknown-key');
  if (keyEpoch !== undefined && entry.keyEpoch !== keyEpoch) bad('key-epoch-mismatch');
  if (entry.alg !== 'Ed25519' || entry.publicKeyJwk?.kty !== 'OKP' || entry.publicKeyJwk?.crv !== 'Ed25519') bad('bad-published-key');
  const publicKey = new Uint8Array(Buffer.from(entry.publicKeyJwk.x, 'base64url'));
  if (publicKey.length !== 32 || !sameBytes(keyIdFor(publicKey), keyId)) bad('published-key-does-not-match-key-id');
  if (!keyUses(entry).includes(KEY_USE.retentionVerifier)) bad('key-is-not-a-retention-verifier');
  if (!(at >= entry.notBefore)) bad('before-key-valid');
  if (entry.notAfter != null && !(at < entry.notAfter)) bad('after-key-expired');
  if (entry.revokedAt != null && !(at < entry.revokedAt)) bad('key-revoked');
  return publicKey;
}

// --- Lease ---

/** Check a lease's fields and its terms (design §3.2, §4). -> the same values, frozen. */
export function checkLease(l) {
  const r = checkAgainst(LEASE_FIELDS, 'lease', l);
  if (!Object.values(GRADE).includes(r.grade)) bad('unknown-grade');
  if (!(r.retentionUntil > r.notBefore)) bad('retention-does-not-follow-not-before');
  if (r.challengePeriod === 0) bad('challenge-period-is-zero');
  if (r.size === 0) bad('size-is-zero');
  if (isZero(r.requester)) bad('requester-is-zero');
  if (isZero(r.verifier)) bad('verifier-is-zero');
  if (r.grade === GRADE.R1) {
    // R1 has no provider node, so there is no piece to commit to.
    if (r.providerReplicas !== 0) bad('r1-with-provider-replicas');
    if (!isZero(r.pieceCommitment)) bad('r1-with-piece-commitment');
  } else {
    if (isZero(r.pieceCommitment)) bad('piece-commitment-missing');
    if (r.grade === GRADE.R2 && r.providerReplicas < 1) bad('r2-needs-a-provider-replica');
    if (r.grade === GRADE.R3 && r.providerReplicas < R3_MIN_PROVIDER_REPLICAS) bad('r3-needs-three-provider-replicas');
  }
  return Object.freeze({ ...r });
}

/** leaseId = hashStruct of the lease with leaseId set to 32 zero bytes. */
export function leaseIdFor(terms) {
  const withZero = { ...terms, leaseId: ZERO32 };
  checkAgainst(LEASE_FIELDS, 'lease', withZero);
  return hashStruct(LEASE_TYPE, LEASE_FIELDS, withZero);
}

/** Lease terms (without leaseId, or with any) -> checked lease carrying its computed leaseId. */
export const leaseFromTerms = (terms) => checkLease({ ...terms, leaseId: leaseIdFor(terms) });

/** The 32-byte EIP-712 digest both parties sign. Refuses a lease whose leaseId is not its own. */
export function leaseDigest(l) {
  const r = checkLease(l);
  if (!sameBytes(r.leaseId, leaseIdFor(r))) bad('lease-id-mismatch');
  return typedDataDigest(LEASE_DOMAIN, LEASE_TYPE, LEASE_FIELDS, r);
}

/**
 * Sign a lease as the requester. `signer` comes from importSigningKey; its keyId must be the
 * lease's requester. -> { alg, publicKey, sig }.
 */
export async function signLeaseAsRequester(lease, signer) {
  if (!sameBytes(lease.requester, signer.keyId)) bad('lease-requester-is-not-the-signer');
  return { alg: 'Ed25519', publicKey: signer.publicKey, sig: new Uint8Array(await subtle().sign('Ed25519', signer.privateKey, leaseDigest(lease))) };
}

/** Sign a lease as its verifier. -> { alg, key (keyId), sig }. */
export async function signLeaseAsVerifier(lease, signer) {
  if (!sameBytes(lease.verifier, signer.keyId)) bad('lease-verifier-is-not-the-signer');
  return { alg: 'Ed25519', key: signer.keyId, sig: new Uint8Array(await subtle().sign('Ed25519', signer.privateKey, leaseDigest(lease))) };
}

/**
 * Verify a lease envelope { v: 1, lease, sigs: { requester, verifier } }. Both signatures are
 * required. The requester's public key travels in the envelope and must hash to lease.requester;
 * the verifier's key must be published in `keys` as a retention verifier and be valid at
 * lease.notBefore. -> the checked lease; throws RetentionError.
 */
export async function verifyLease(env, keys) {
  if (!env || env.v !== 1) bad('not-a-v1-lease');
  const l = checkLease(env.lease);
  const digest = leaseDigest(l);
  const rq = env.sigs?.requester, vf = env.sigs?.verifier;
  if (!rq) bad('requester-signature-missing');
  if (!vf) bad('verifier-signature-missing');
  checkSigShape(rq, 'publicKey'); checkSigShape(vf, 'key');
  if (!sameBytes(keyIdFor(rq.publicKey), l.requester)) bad('requester-key-does-not-match-lease');
  if (!(await verifyEd25519(rq.publicKey, rq.sig, digest))) bad('bad-requester-signature');
  if (!sameBytes(vf.key, l.verifier)) bad('verifier-key-does-not-match-lease');
  const verifierKey = verifierKeyAt(keys, l.verifier, l.notBefore);
  if (!(await verifyEd25519(verifierKey, vf.sig, digest))) bad('bad-verifier-signature');
  return l;
}

// A lease proposal is a lease the requester has signed and the verifier has not: the form in which
// it travels to the verifier for the second signature. It is not a lease and verifyLease refuses it.
export const leaseProposalToJson = (p) => ({ v: 1, lease: fieldsToJson(LEASE_FIELDS, checkLease(p.lease)), sigs: { requester: sigToJson(p.sigs.requester, 'publicKey') } });

export function leaseProposalFromJson(j) {
  if (!j || j.v !== 1 || !j.lease || !j.sigs?.requester) bad('not-a-v1-lease-proposal');
  if (j.sigs.verifier !== undefined) bad('proposal-already-has-a-verifier-signature');
  return { v: 1, lease: checkLease(fieldsFromJson(LEASE_FIELDS, j.lease)), sigs: { requester: sigFromJson(j.sigs.requester, 'publicKey') } };
}

/** Check a proposal: the lease id is its own and the requester named in it signed it. -> the lease. */
export async function verifyLeaseProposal(p) {
  if (!p || p.v !== 1) bad('not-a-v1-lease-proposal');
  const l = checkLease(p.lease);
  const digest = leaseDigest(l);
  const rq = p.sigs?.requester;
  if (!rq) bad('requester-signature-missing');
  checkSigShape(rq, 'publicKey');
  if (!sameBytes(keyIdFor(rq.publicKey), l.requester)) bad('requester-key-does-not-match-lease');
  if (!(await verifyEd25519(rq.publicKey, rq.sig, digest))) bad('bad-requester-signature');
  return l;
}

export const leaseEnvelopeToJson = (env) => ({ v: 1, lease: fieldsToJson(LEASE_FIELDS, checkLease(env.lease)),
  sigs: { requester: sigToJson(env.sigs.requester, 'publicKey'), verifier: sigToJson(env.sigs.verifier, 'key') } });

export function leaseEnvelopeFromJson(j) {
  if (!j || j.v !== 1 || !j.lease || !j.sigs) bad('not-a-v1-lease');
  return { v: 1, lease: checkLease(fieldsFromJson(LEASE_FIELDS, j.lease)),
           sigs: { requester: sigFromJson(j.sigs.requester, 'publicKey'), verifier: sigFromJson(j.sigs.verifier, 'key') } };
}

/** Canonical DAG-CBOR record of a lease envelope and its CID. */
export function leaseEnvelopeToDagCbor(env) {
  const bytes = encodeDagCbor({ v: 1, lease: { ...checkLease(env.lease) },
    sigs: { requester: { ...env.sigs.requester }, verifier: { ...env.sigs.verifier } } });
  return { bytes, cid: cidFor(bytes, CODEC_DAG_CBOR) };
}

export function leaseEnvelopeFromDagCbor(bytes) {
  let v;
  try { v = decodeDagCbor(bytes).value; } catch { bad('record-not-dag-cbor'); }
  const s = v instanceof Map ? v.get('sigs') : null;
  if (!(v instanceof Map) || v.size !== 3 || v.get('v') !== 1n || !(s instanceof Map) || s.size !== 2) bad('not-a-v1-record');
  const rq = s.get('requester'), vf = s.get('verifier');
  if (!(rq instanceof Map) || rq.size !== 3 || !(vf instanceof Map) || vf.size !== 3) bad('bad-record-signature');
  return { v: 1, lease: checkLease(fieldsFromCbor(v.get('lease'))),
           sigs: { requester: { alg: rq.get('alg'), publicKey: rq.get('publicKey'), sig: rq.get('sig') },
                   verifier: { alg: vf.get('alg'), key: vf.get('key'), sig: vf.get('sig') } } };
}

// --- Inventory (the subject of a lease over several blocks) ---

/**
 * Canonical record of a set of blocks: DAG-CBOR {"v": 1, "blocks": [links]}, the binary CIDs
 * sorted bytewise ascending with duplicates removed (the order of blockSetDigest).
 * -> { bytes, commitment (sha256 of bytes, the lease subject), cid }.
 */
export function inventoryRecord(cids) {
  if (!Array.isArray(cids) || cids.length === 0) bad('inventory-is-empty');
  const bins = [...new Set(cids)].map((c) => cidToBytes(c) ?? bad('cid-not-cidv1'));
  bins.sort((a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; });
  const bytes = encodeDagCbor({ v: 1, blocks: bins.map((b) => ({ cid: b })) });
  return { bytes, commitment: sha256(bytes), cid: cidFor(bytes, CODEC_DAG_CBOR) };
}

// --- Status ---

export function checkStatus(s) {
  const r = checkAgainst(STATUS_FIELDS, 'status', s);
  if (!Object.values(GRADE).includes(r.grade)) bad('unknown-grade');
  if (!Object.values(STATUS).includes(r.status)) bad('unknown-status');
  if (!(r.validUntil > r.observedAt)) bad('valid-until-does-not-follow-observed-at');
  return Object.freeze({ ...r });
}

export const statusDigest = (s) => typedDataDigest(STATUS_DOMAIN, STATUS_TYPE, STATUS_FIELDS, checkStatus(s));

/** Does this many verified copies meet the lease's grade (design §3.2)? */
export function gradeSatisfied(lease, { providerReplicas, operatorCopies }) {
  if (lease.grade === GRADE.R1) return operatorCopies >= 1;
  if (lease.grade === GRADE.R2) return operatorCopies >= 1 && providerReplicas >= Math.max(1, lease.providerReplicas);
  if (lease.grade === GRADE.R3) return providerReplicas >= Math.max(R3_MIN_PROVIDER_REPLICAS, lease.providerReplicas);
  return false;
}

/** Sign a status as the verifier. -> envelope { v: 1, status, sig: { alg, key, sig } }. */
export async function signStatus(fields, signer) {
  const s = checkStatus(fields);
  if (!sameBytes(s.keyId, signer.keyId)) bad('status-key-id-is-not-the-signer');
  return { v: 1, status: s, sig: { alg: 'Ed25519', key: signer.keyId, sig: new Uint8Array(await subtle().sign('Ed25519', signer.privateKey, statusDigest(s))) } };
}

/**
 * Verify a status envelope against the lease it speaks about (already verified with verifyLease)
 * and the published key set. `now` is the reader's clock in Unix ms.
 *
 * A status past its validUntil is refused with 'status-stale': the state is then unknown, not
 * whatever the last record said (design §6). -> the checked status; throws RetentionError.
 */
export async function verifyStatus(env, lease, keys, { now }) {
  if (!env || env.v !== 1) bad('not-a-v1-status');
  if (!Number.isSafeInteger(now)) bad('now-required');
  const s = checkStatus(env.status);
  const l = checkLease(lease);
  checkSigShape(env.sig, 'key');
  if (!sameBytes(env.sig.key, s.keyId)) bad('signature-key-is-not-status-key');
  // 1. Only the lease's own verifier may speak about it.
  if (!sameBytes(s.keyId, l.verifier)) bad('status-not-from-the-lease-verifier');
  const publicKey = verifierKeyAt(keys, s.keyId, s.observedAt, s.keyEpoch);
  if (!(await verifyEd25519(publicKey, env.sig.sig, statusDigest(s)))) bad('bad-signature');
  // 2. It must be about this lease.
  if (!sameBytes(s.leaseId, l.leaseId)) bad('lease-id-mismatch');
  if (!sameBytes(s.subject, l.subject)) bad('subject-mismatch');
  if (s.grade !== l.grade) bad('grade-mismatch');
  // 3. Time: not from the future, not trusted for longer than the design allows, not stale.
  if (s.observedAt > now + MAX_CLOCK_SKEW_MS) bad('status-from-the-future');
  if (s.validUntil - s.observedAt > STATUS_MAX_VALIDITY_PERIODS * l.challengePeriod * 1000) bad('status-valid-for-too-long');
  if (!(now < s.validUntil)) bad('status-stale');
  // 4. What the status claims must follow from the counts it carries and from the lease's term.
  if (s.status === STATUS.policySatisfied) {
    if (!(s.observedAt >= l.notBefore && s.observedAt < l.retentionUntil)) bad('satisfied-outside-the-lease-term');
    if (!gradeSatisfied(l, s)) bad('satisfied-without-the-required-copies');
  }
  if (s.status === STATUS.expired && !(s.observedAt >= l.retentionUntil)) bad('expired-before-retention-until');
  return s;
}

export const statusEnvelopeToJson = (env) => ({ v: 1, status: fieldsToJson(STATUS_FIELDS, checkStatus(env.status)), sig: sigToJson(env.sig, 'key') });

export function statusEnvelopeFromJson(j) {
  if (!j || j.v !== 1 || !j.status || !j.sig) bad('not-a-v1-status');
  return { v: 1, status: checkStatus(fieldsFromJson(STATUS_FIELDS, j.status)), sig: sigFromJson(j.sig, 'key') };
}

export function statusEnvelopeToDagCbor(env) {
  const bytes = encodeDagCbor({ v: 1, status: { ...checkStatus(env.status) }, sig: { ...env.sig } });
  return { bytes, cid: cidFor(bytes, CODEC_DAG_CBOR) };
}

export function statusEnvelopeFromDagCbor(bytes) {
  let v;
  try { v = decodeDagCbor(bytes).value; } catch { bad('record-not-dag-cbor'); }
  const s = v instanceof Map ? v.get('sig') : null;
  if (!(v instanceof Map) || v.size !== 3 || v.get('v') !== 1n || !(s instanceof Map) || s.size !== 3) bad('not-a-v1-record');
  return { v: 1, status: checkStatus(fieldsFromCbor(v.get('status'))), sig: { alg: s.get('alg'), key: s.get('key'), sig: s.get('sig') } };
}

// --- Receipts against a lease ---

/**
 * Does a verified storage receipt (from verifyReceipt) count towards this lease? It must name the
 * lease, promise at least the lease's term, and come from a store class that makes a promise.
 * -> 'operator-archive' | 'provider-node'; throws RetentionError. A gateway receipt never counts.
 */
export function receiptCountsFor(receipt, lease) {
  const l = checkLease(lease);
  if (receipt.storeClass === STORE_CLASS.edgeGateway) bad('gateway-receipt-is-not-counted');
  if (!sameBytes(receipt.leaseId, l.leaseId)) bad('receipt-is-for-another-lease');
  if (!(receipt.retentionUntil >= l.retentionUntil)) bad('receipt-promises-less-than-the-lease');
  // An operator archive copy is required for R1 and R2 and is an optional extra copy for R3.
  if (receipt.storeClass === STORE_CLASS.operatorArchive) return 'operator-archive';
  if (receipt.storeClass === STORE_CLASS.providerNode) {
    if (l.grade === GRADE.R1) bad('r1-lease-has-no-provider-node');
    if (!sameBytes(receipt.pieceCommitment, l.pieceCommitment)) bad('piece-commitment-mismatch');
    return 'provider-node';
  }
  return bad('unknown-store-class');
}
