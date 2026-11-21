// Yataverse storage receipt v1 (docs/storage-receipt-design.md, AWAI-3268).
// An EIP-712 typed-data struct, signed with Ed25519 over the EIP-712 digest. The same values
// travel as JSON (in write responses) and as canonical DAG-CBOR (the stored record); the
// signature does not depend on either encoding.
import crypto from 'node:crypto';
import { typedDataDigest, typeString } from './eip712.mjs';
import { encodeDagCbor, decodeDagCbor } from './dag-cbor.mjs';
import { cidFor, cidToBytes, CODEC_DAG_CBOR } from './cid.mjs';

export class ReceiptError extends Error { constructor(code) { super(code); this.code = code; } }
const bad = (code) => { throw new ReceiptError(code); };

export const RECEIPT_TYPE = 'YataverseStorageReceipt';
export const RECEIPT_FIELDS = [
  ['kind', 'uint8'], ['subject', 'bytes'], ['size', 'uint64'], ['contentDigest', 'bytes32'],
  ['requestId', 'bytes32'], ['requester', 'bytes32'], ['reservationId', 'bytes32'], ['leaseId', 'bytes32'],
  ['pieceCommitment', 'bytes32'], ['policyRevision', 'bytes32'], ['state', 'uint8'], ['storeClass', 'uint8'],
  ['acceptedAt', 'uint64'], ['retentionUntil', 'uint64'], ['keyId', 'bytes32'], ['keyEpoch', 'uint32'],
];
// Owner decision 2026-11-18 (design §10, decision 2): no chainId or verifyingContract until the
// Awai L1 chain ID exists; the version distinguishes the format.
export const RECEIPT_DOMAIN = Object.freeze({ name: 'Awai Yataverse Storage Receipt', version: '1' });
export const RECEIPT_TYPE_STRING = typeString(RECEIPT_TYPE, RECEIPT_FIELDS);
export const SIGNER_DID = 'did:web:yataverse.com';
export const KIND = Object.freeze({ block: 1, car: 2, drivePack: 3 });
export const STATE = Object.freeze({ localDurableReadback: 1, localDurable: 2, policySatisfied: 10 });
// 3 = operator-archive (docs/retention-design.md §3): a B2 bucket with Object Lock, counted as the
// operator's own copy and never as an independent replica.
export const STORE_CLASS = Object.freeze({ edgeGateway: 1, providerNode: 2, operatorArchive: 3 });
// What a published key may sign. A key entry without `use` is a gateway receipt key only, so the
// existing key set cannot vouch for a retention promise or act as a verifier.
export const KEY_USE = Object.freeze({ gatewayReceipt: 'gateway-receipt', providerReceipt: 'provider-receipt',
  operatorArchiveReceipt: 'operator-archive-receipt', retentionVerifier: 'retention-verifier' });
const USE_FOR_STORE_CLASS = Object.freeze({ 1: KEY_USE.gatewayReceipt, 2: KEY_USE.providerReceipt, 3: KEY_USE.operatorArchiveReceipt });
/** The uses a published key entry allows. */
export const keyUses = (entry) => (Array.isArray(entry?.use) ? entry.use.filter((u) => typeof u === 'string') : [KEY_USE.gatewayReceipt]);
const UINT_BITS = Object.fromEntries(RECEIPT_FIELDS.filter(([, t]) => t.startsWith('uint')).map(([n, t]) => [n, Number(t.slice(4))]));
const ZERO32 = new Uint8Array(32);
const MAX_SUBJECT_BYTES = 128;

const sha256 = (b) => new Uint8Array(crypto.createHash('sha256').update(b).digest());
const toHex = (b) => '0x' + Buffer.from(b).toString('hex');
const b64url = (b) => Buffer.from(b).toString('base64url');
const subtle = () => globalThis.crypto?.subtle ?? crypto.webcrypto.subtle;
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function fromHex(s, field, len) {
  if (typeof s !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(s)) bad(`bad-hex:${field}`);
  const b = new Uint8Array(Buffer.from(s.slice(2), 'hex'));
  if (len !== undefined && b.length !== len) bad(`bad-length:${field}`);
  return b;
}

/** Check a receipt's fields (bytes as Uint8Array, integers as safe integers). -> the same object, frozen. */
export function checkFields(r) {
  if (!r || typeof r !== 'object') bad('receipt-not-an-object');
  const keys = Object.keys(r);
  if (keys.length !== RECEIPT_FIELDS.length || RECEIPT_FIELDS.some(([n]) => !Object.hasOwn(r, n))) bad('receipt-fields-do-not-match');
  for (const [n, t] of RECEIPT_FIELDS) {
    const v = r[n];
    if (t === 'bytes32') { if (!(v instanceof Uint8Array) || v.length !== 32) bad(`bad-bytes32:${n}`); }
    else if (t === 'bytes') { if (!(v instanceof Uint8Array) || v.length === 0 || v.length > MAX_SUBJECT_BYTES) bad(`bad-bytes:${n}`); }
    else if (!Number.isSafeInteger(v) || v < 0 || BigInt(v) >= 1n << BigInt(UINT_BITS[n])) bad(`bad-uint:${n}`);
  }
  return Object.freeze({ ...r });
}

/** The 32-byte EIP-712 digest that is signed. */
export const receiptDigest = (r) => typedDataDigest(RECEIPT_DOMAIN, RECEIPT_TYPE, RECEIPT_FIELDS, checkFields(r));

/** keyId = sha256(multicodec ed25519-pub (0xed 0x01) || 32-byte public key). */
export function keyIdFor(publicKey) {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) bad('bad-ed25519-public-key');
  const b = new Uint8Array(34); b[0] = 0xed; b[1] = 0x01; b.set(publicKey, 2);
  return sha256(b);
}

/**
 * Import a signing key from an Ed25519 private JWK ({kty:"OKP", crv:"Ed25519", d, x}).
 * -> { privateKey, publicKey (32 bytes), keyId }.
 */
export async function importSigningKey(jwk) {
  const j = typeof jwk === 'string' ? JSON.parse(jwk) : jwk;
  if (j?.kty !== 'OKP' || j?.crv !== 'Ed25519' || typeof j.d !== 'string' || typeof j.x !== 'string') bad('bad-signing-jwk');
  // Some runtimes reject a JWK whose x does not belong to d at import; others accept it, which
  // the probe below catches. Either way the key is refused.
  let privateKey;
  try { privateKey = await subtle().importKey('jwk', { kty: 'OKP', crv: 'Ed25519', d: j.d, x: j.x }, { name: 'Ed25519' }, false, ['sign']); }
  catch { bad('signing-jwk-rejected'); }
  const publicKey = new Uint8Array(Buffer.from(j.x, 'base64url'));
  // The x in the JWK must belong to d: sign once and verify with x, so a mismatched pair fails here.
  const probe = new Uint8Array(32);
  const sig = new Uint8Array(await subtle().sign('Ed25519', privateKey, probe));
  const pub = await subtle().importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
  if (!(await subtle().verify('Ed25519', pub, sig, probe))) bad('signing-jwk-x-does-not-match-d');
  return { privateKey, publicKey, keyId: keyIdFor(publicKey) };
}

/** Sign receipt fields. -> envelope { v: 1, receipt, sig: { alg, key, sig } } with byte values. */
export async function signReceipt(fields, signer) {
  const r = checkFields(fields);
  if (!sameBytes(r.keyId, signer.keyId)) bad('receipt-key-id-is-not-the-signer');
  const sig = new Uint8Array(await subtle().sign('Ed25519', signer.privateKey, receiptDigest(r)));
  return { v: 1, receipt: r, sig: { alg: 'Ed25519', key: signer.keyId, sig } };
}

/** JSON form: bytes as 0x hex, integers as numbers, the signature as base64url. */
export function envelopeToJson(env) {
  const receipt = {};
  for (const [n, t] of RECEIPT_FIELDS) receipt[n] = t.startsWith('uint') ? env.receipt[n] : toHex(env.receipt[n]);
  return { v: 1, receipt, sig: { alg: env.sig.alg, key: toHex(env.sig.key), sig: b64url(env.sig.sig) } };
}

export function envelopeFromJson(j) {
  if (!j || j.v !== 1 || !j.receipt || !j.sig) bad('not-a-v1-receipt');
  const receipt = {};
  for (const k of Object.keys(j.receipt)) if (!RECEIPT_FIELDS.some(([n]) => n === k)) bad(`unknown-field:${k}`);
  for (const [n, t] of RECEIPT_FIELDS) {
    const v = j.receipt[n];
    receipt[n] = t.startsWith('uint') ? v : fromHex(v, n, t === 'bytes32' ? 32 : undefined);
  }
  if (typeof j.sig.sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(j.sig.sig)) bad('bad-signature-encoding');
  return { v: 1, receipt: checkFields(receipt),
           sig: { alg: j.sig.alg, key: fromHex(j.sig.key, 'sig.key', 32), sig: new Uint8Array(Buffer.from(j.sig.sig, 'base64url')) } };
}

/** Canonical DAG-CBOR record of an envelope and its CID (codec dag-cbor). */
export function envelopeToDagCbor(env) {
  const bytes = encodeDagCbor({ v: 1, receipt: { ...checkFields(env.receipt) }, sig: { alg: env.sig.alg, key: env.sig.key, sig: env.sig.sig } });
  return { bytes, cid: cidFor(bytes, CODEC_DAG_CBOR) };
}

export function envelopeFromDagCbor(bytes) {
  let v;
  try { v = decodeDagCbor(bytes).value; } catch { bad('record-not-dag-cbor'); }
  const r = v instanceof Map ? v.get('receipt') : null;
  const s = v instanceof Map ? v.get('sig') : null;
  if (!(v instanceof Map) || v.size !== 3 || v.get('v') !== 1n || !(r instanceof Map) || !(s instanceof Map) || s.size !== 3) bad('not-a-v1-record');
  const receipt = {};
  for (const [k, x] of r) receipt[k] = typeof x === 'bigint' ? (x <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(x) : bad(`bad-uint:${k}`)) : x;
  const key = s.get('key'), sig = s.get('sig');
  if (!(key instanceof Uint8Array) || key.length !== 32 || !(sig instanceof Uint8Array)) bad('bad-record-signature');
  return { v: 1, receipt: checkFields(receipt), sig: { alg: s.get('alg'), key, sig } };
}

/**
 * Verify an envelope against a published key set (design §6). `keys` is the parsed
 * /.well-known/yataverse-receipt-keys.json; `expect` optionally pins subject, contentDigest,
 * size, requestId and kind to the caller's own values. -> the checked receipt; throws ReceiptError.
 */
export async function verifyReceipt(env, keys, expect = {}) {
  const r = checkFields(env?.receipt);
  if (env.v !== 1) bad('not-a-v1-receipt');
  if (env.sig?.alg !== 'Ed25519') bad('unsupported-signature-algorithm');
  if (!(env.sig.sig instanceof Uint8Array) || env.sig.sig.length !== 64) bad('bad-signature-length');
  if (!sameBytes(env.sig.key, r.keyId)) bad('signature-key-is-not-receipt-key');
  // 1. The key: published, same epoch, valid at acceptedAt, not revoked by then.
  const entry = (keys?.keys ?? []).find((k) => k.keyId === toHex(r.keyId));
  if (!entry) bad('unknown-key');
  if (entry.keyEpoch !== r.keyEpoch) bad('key-epoch-mismatch');
  if (entry.alg !== 'Ed25519' || entry.publicKeyJwk?.kty !== 'OKP' || entry.publicKeyJwk?.crv !== 'Ed25519') bad('bad-published-key');
  const publicKey = new Uint8Array(Buffer.from(entry.publicKeyJwk.x, 'base64url'));
  if (!sameBytes(keyIdFor(publicKey), r.keyId)) bad('published-key-does-not-match-key-id');
  if (!(r.acceptedAt >= entry.notBefore)) bad('accepted-before-key-valid');
  if (entry.notAfter != null && !(r.acceptedAt < entry.notAfter)) bad('accepted-after-key-expired');
  if (entry.revokedAt != null && !(r.acceptedAt < entry.revokedAt)) bad('key-revoked');
  // 2. The signature over the EIP-712 digest.
  const pub = await subtle().importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
  if (!(await subtle().verify('Ed25519', pub, env.sig.sig, receiptDigest(r)))) bad('bad-signature');
  // 3. The caller's own values.
  for (const k of ['subject', 'contentDigest', 'requestId', 'requester']) if (expect[k] !== undefined && !sameBytes(expect[k], r[k])) bad(`${k}-mismatch`);
  for (const k of ['size', 'kind']) if (expect[k] !== undefined && expect[k] !== r[k]) bad(`${k}-mismatch`);
  // 4. What an entry gateway may claim.
  if (r.state === STATE.policySatisfied) bad('gateway-claims-policy-satisfied');
  if (r.state !== STATE.localDurableReadback) bad('unknown-state');
  if (!Object.values(STORE_CLASS).includes(r.storeClass)) bad('unknown-store-class');
  if (!Object.values(KIND).includes(r.kind)) bad('unknown-kind');
  // 5. What each store class may promise (docs/retention-design.md §5), and which key may say it.
  if (!keyUses(entry).includes(USE_FOR_STORE_CLASS[r.storeClass])) bad('key-not-allowed-for-store-class');
  const zero = (b) => b.every((x) => x === 0);
  if (r.storeClass === STORE_CLASS.edgeGateway) {
    // The gateway accepts and reads back; it does not promise retention.
    if (r.retentionUntil !== 0) bad('gateway-claims-retention');
  } else {
    if (zero(r.leaseId)) bad('retention-receipt-without-lease');
    if (!(r.retentionUntil > r.acceptedAt)) bad('retention-does-not-follow-accepted-at');
    if (r.storeClass === STORE_CLASS.providerNode && zero(r.pieceCommitment)) bad('provider-receipt-without-piece-commitment');
    if (r.storeClass === STORE_CLASS.operatorArchive && !zero(r.pieceCommitment)) bad('operator-archive-with-piece-commitment');
  }
  return r;
}

// --- Field values derived from what was written (design §3.1) ---

/** sha256 of canonical DAG-CBOR {"roots": [links]} in CAR header order. */
export const rootsCommitment = (roots) => sha256(encodeDagCbor({ roots: roots.map((c) => ({ cid: cidToBytes(c) ?? bad('root-not-cidv1') })) }));

/** sha256 of the binary CIDs, sorted bytewise ascending and each prefixed by varint(length). */
export function blockSetDigest(cids) {
  const bins = [...new Set(cids)].map((c) => cidToBytes(c) ?? bad('cid-not-cidv1'));
  bins.sort((a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; });
  const parts = [];
  for (const b of bins) {
    let n = b.length; const v = [];
    while (n >= 0x80) { v.push((n & 0x7f) | 0x80); n >>>= 7; } v.push(n);
    parts.push(Uint8Array.from(v), b);
  }
  return sha256(Buffer.concat(parts));
}

/**
 * The requester field for a write: SHA-256 of the bearer token, as the gateway computes it from
 * the Authorization header (16 to 512 visible ASCII characters), or 32 zero bytes without one.
 */
export function requesterFor(authorization) {
  const m = /^Bearer ([\x21-\x7e]{16,512})$/.exec(authorization ?? '');
  return m ? sha256(m[1]) : ZERO32;
}

/** Policy record {source, limits, store} -> { bytes (DAG-CBOR), revision (its sha256), cid }. */
export function policyRecord(policy) {
  const bytes = encodeDagCbor(policy);
  return { bytes, revision: sha256(bytes), cid: cidFor(bytes, CODEC_DAG_CBOR) };
}

export { ZERO32 };
