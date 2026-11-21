// Signed storage receipts on yataverse.com writes (docs/storage-receipt-design.md, AWAI-3305).
//
// Every successful write (block PUT, CAR POST, Drive pack PUT) returns a YataverseStorageReceipt
// v1 signed with Ed25519 over its EIP-712 digest. The receipt record (canonical DAG-CBOR) is kept
// in B2 at <B2_PREFIX>receipts/by-request/<requestId hex>, so a repeated request gets the same
// receipt back and a different write under the same requestId is refused (409).
//
// Configuration:
//   RECEIPT_SIGNING_KEY  secret: the Ed25519 private JWK {kty, crv, d, x}.
//   RECEIPT_PUBLIC_KEYS  var: the published key set {v, signer, keys: [...]}, served at
//                        /.well-known/yataverse-receipt-keys.json and in /.well-known/did.json.
//   SOURCE_COMMIT        var, set at deploy: the Worker's source commit, part of the policy.
// Without a signing key whose keyId is published and valid now, writes fail closed (503):
// the Worker never returns an unsigned or unverifiable success.
import crypto from 'node:crypto';
import {
  importSigningKey, signReceipt, envelopeToJson, envelopeFromJson, envelopeToDagCbor, envelopeFromDagCbor, policyRecord,
  checkFields, requesterFor, keyUses, ReceiptError, SIGNER_DID, STATE, STORE_CLASS, KEY_USE, ZERO32,
} from '../../src/receipt.mjs';

const hex = (b) => Buffer.from(b).toString('hex');
const sha256 = (b) => new Uint8Array(crypto.createHash('sha256').update(b).digest());
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
export const REQUEST_ID_HEADER = 'yataverse-request-id';

// Write limits enforced outside this Worker, declared in the policy so a receipt says which
// rules applied. Keep in step with the Cloudflare WAF rule (AWAI-3242, README "Write limits").
export const EXTERNAL_WRITE_LIMITS = Object.freeze({
  wafRateLimit: { characteristics: 'ip', requests: 10, periodSeconds: 10, action: 'block', blockSeconds: 10 },
});

export function publishedKeys(env) {
  const v = env.RECEIPT_PUBLIC_KEYS;
  if (!v) return { v: 1, signer: SIGNER_DID, keys: [] };
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return { v: 1, signer: SIGNER_DID, keys: [] }; }
}

const active = (k, nowMs) => k.notBefore <= nowMs && (k.notAfter == null || nowMs < k.notAfter) && (k.revokedAt == null || nowMs < k.revokedAt);

const cachedSigners = new Map();   // secret name -> { source, signer }
async function signerFor(env, name = 'RECEIPT_SIGNING_KEY') {
  if (!env[name]) return null;
  if (cachedSigners.get(name)?.source !== env[name]) cachedSigners.set(name, { source: env[name], signer: await importSigningKey(env[name]) });
  return cachedSigners.get(name).signer;
}

/** The policy in force: {source, limits, store} and its revision (design §3.1). */
export function currentPolicy(env, limits) {
  const policy = {
    source: String(env.SOURCE_COMMIT || 'unrecorded'),
    limits: { ...limits, external: EXTERNAL_WRITE_LIMITS },
    store: { provider: 'backblaze-b2', bucket: String(env.B2_BUCKET ?? ''), prefix: String(env.B2_PREFIX ?? 'ipld/') },
  };
  return { policy, ...policyRecord(policy) };
}

/** The request id: the Yataverse-Request-Id header (64 hex) or, without one, the content digest. */
export function requestIdOf(request, contentDigest) {
  const h = request.headers.get(REQUEST_ID_HEADER);
  if (h === null) return { requestId: contentDigest };
  const m = /^(?:0x)?([0-9a-f]{64})$/.exec(h.trim().toLowerCase());
  return m ? { requestId: new Uint8Array(Buffer.from(m[1], 'hex')) } : { error: [400, 'bad-request-id'] };
}

const SAME = ['kind', 'subject', 'size', 'contentDigest', 'requester'];

/**
 * Before storing: check the signer and any earlier receipt for this requestId.
 * claim: {kind, subject, size, contentDigest, requestId, requester} (bytes as Uint8Array).
 * -> { error: [status, code] } | { prior: { json, cid } } | { fresh: true }.
 */
export async function beginReceipt(claim, env, deps, store) {
  let signer;
  try { signer = await signerFor(env); } catch (e) { if (e instanceof ReceiptError) return { error: [503, 'receipt-key-invalid'] }; throw e; }
  if (!signer) return { error: [503, 'receipts-not-configured'] };
  const entry = publishedKeys(env).keys?.find((k) => k.keyId === '0x' + hex(signer.keyId));
  if (!entry) return { error: [503, 'receipt-key-not-published'] };
  if (!active(entry, deps.now().getTime())) return { error: [503, 'receipt-key-not-valid-now'] };
  const res = await store.getReceipt(hex(claim.requestId));
  if (res.status === 404) return { fresh: true, signer, entry };
  if (res.status !== 200) return { error: [502, `receipt-read-failed-${res.status}`] };
  const bytes = new Uint8Array(await res.arrayBuffer());
  let env1;
  try { env1 = envelopeFromDagCbor(bytes); } catch { return { error: [502, 'stored-receipt-unreadable'] }; }
  for (const k of SAME) {
    const a = env1.receipt[k], b = claim[k];
    if (a instanceof Uint8Array ? !sameBytes(a, b) : a !== b) return { error: [409, 'request-id-conflict'] };
  }
  const { cid } = envelopeToDagCbor(env1);
  return { prior: { json: envelopeToJson(env1), cid }, signer, entry };
}

/**
 * After the bytes are stored and read back: return the earlier receipt for a repeated request,
 * or sign, store and return a new one. -> { error } | { json, cid }.
 */
export async function finishReceipt(begun, claim, env, deps, store, limits) {
  if (begun.prior) return begun.prior;
  const pol = currentPolicy(env, limits);
  await ensurePolicyStored(pol, store);
  const fields = checkFields({
    kind: claim.kind, subject: claim.subject, size: claim.size, contentDigest: claim.contentDigest,
    requestId: claim.requestId, requester: claim.requester ?? ZERO32,
    reservationId: ZERO32, leaseId: ZERO32, pieceCommitment: ZERO32, policyRevision: pol.revision,
    state: STATE.localDurableReadback, storeClass: STORE_CLASS.edgeGateway,
    acceptedAt: deps.now().getTime(), retentionUntil: 0, keyId: begun.signer.keyId, keyEpoch: begun.entry.keyEpoch,
  });
  const envelope = await signReceipt(fields, begun.signer);
  const { bytes, cid } = envelopeToDagCbor(envelope);
  const put = await store.putReceipt(hex(claim.requestId), bytes);
  if (put.status !== 200) return { error: [502, `receipt-write-failed-${put.status}`] };
  return { json: envelopeToJson(envelope), cid };
}

// The policy record is stored as an ordinary dag-cbor block, so every revision a receipt names
// stays readable at /ipfs/<cid> after later deploys. One HEAD per new receipt (no isolate cache),
// so a missing policy block is always written again before a receipt names it.
async function ensurePolicyStored(pol, store) {
  const head = await store.head(pol.cid);
  if (head.status === 404) {
    const put = await store.put(pol.cid, pol.bytes, hex(pol.revision));
    if (put.status !== 200) throw new Error(`policy-write-failed-${put.status}`);
  } else if (head.status !== 200) throw new Error(`policy-head-failed-${head.status}`);
}

/** GET /.well-known/... documents. -> Response or null. */
export function wellKnown(pathname, env, limits, json) {
  if (pathname === '/.well-known/yataverse-receipt-keys.json') return json(200, publishedKeys(env));
  if (pathname === '/.well-known/did.json') {
    const keys = publishedKeys(env).keys ?? [];
    const vm = keys.map((k) => ({ id: `${SIGNER_DID}#${k.keyId}`, type: 'JsonWebKey2020', controller: SIGNER_DID, publicKeyJwk: k.publicKeyJwk }));
    const usable = keys.filter((k) => k.revokedAt == null).map((k) => `${SIGNER_DID}#${k.keyId}`);
    return json(200, { '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
      id: SIGNER_DID, verificationMethod: vm, assertionMethod: usable });
  }
  const m = /^\/\.well-known\/yataverse-policy\/(?:0x)?([0-9a-f]{64})\.json$/.exec(pathname);
  if (m) {
    const pol = currentPolicy(env, limits);
    if (hex(pol.revision) !== m[1]) return json(404, { error: 'policy-not-current', hint: 'earlier revisions are dag-cbor blocks at /ipfs/<cid>' });
    return json(200, { revision: '0x' + hex(pol.revision), cid: pol.cid, policy: pol.policy });
  }
  if (pathname === '/.well-known/yataverse-policy/current.json') {
    const pol = currentPolicy(env, limits);
    return json(200, { revision: '0x' + hex(pol.revision), cid: pol.cid, policy: pol.policy });
  }
  return null;
}

// --- Operator archive receipts (docs/retention-design.md §3.1, §5; AWAI-3675) ---

const ARCHIVE_SAME = ['kind', 'subject', 'size', 'contentDigest', 'requester', 'leaseId'];

/**
 * Before a locking write: the archive signer (ARCHIVE_RECEIPT_SIGNING_KEY, a different key from the
 * gateway's, published with use operator-archive-receipt) and any earlier archive receipt for this
 * requestId. -> { error } | { prior: { json, cid, record } } | { fresh: true, signer, entry }.
 */
export async function beginArchiveReceipt(claim, env, deps, store) {
  let signer;
  try { signer = await signerFor(env, 'ARCHIVE_RECEIPT_SIGNING_KEY'); } catch (e) { if (e instanceof ReceiptError) return { error: [503, 'archive-receipt-key-invalid'] }; throw e; }
  if (!signer) return { error: [503, 'archive-not-configured'] };
  const entry = publishedKeys(env).keys?.find((k) => k.keyId === '0x' + hex(signer.keyId));
  if (!entry) return { error: [503, 'archive-receipt-key-not-published'] };
  if (!keyUses(entry).includes(KEY_USE.operatorArchiveReceipt)) return { error: [503, 'archive-receipt-key-not-allowed'] };
  if (!active(entry, deps.now().getTime())) return { error: [503, 'archive-receipt-key-not-valid-now'] };
  const res = await store.getArchiveReceipt(hex(claim.requestId));
  if (res.status === 404) return { fresh: true, signer, entry };
  if (res.status !== 200) return { error: [502, `archive-receipt-read-failed-${res.status}`] };
  let rec;
  try { rec = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8')); } catch { return { error: [502, 'stored-archive-receipt-unreadable'] }; }
  let env1;
  try { env1 = envelopeFromJson(rec.receipt); } catch { return { error: [502, 'stored-archive-receipt-unreadable'] }; }
  for (const k of ARCHIVE_SAME) {
    const a = env1.receipt[k], b = claim[k];
    if (a instanceof Uint8Array ? !sameBytes(a, b) : a !== b) return { error: [409, 'request-id-conflict'] };
  }
  return { prior: { json: rec.receipt, cid: envelopeToDagCbor(env1).cid, archive: rec.archive }, signer, entry };
}

/**
 * After the locked version was stored and checked: sign and store the storeClass 3 receipt.
 * `archive` = { versionId, lockMode, retainUntil (Unix ms, read back from the store) }.
 */
export async function finishArchiveReceipt(begun, claim, archive, env, deps, store, limits) {
  const pol = currentPolicy(env, limits);
  await ensurePolicyStored(pol, store);
  const fields = checkFields({
    kind: claim.kind, subject: claim.subject, size: claim.size, contentDigest: claim.contentDigest,
    requestId: claim.requestId, requester: claim.requester ?? ZERO32,
    reservationId: ZERO32, leaseId: claim.leaseId, pieceCommitment: ZERO32, policyRevision: pol.revision,
    state: STATE.localDurableReadback, storeClass: STORE_CLASS.operatorArchive,
    acceptedAt: deps.now().getTime(), retentionUntil: archive.retainUntil, keyId: begun.signer.keyId, keyEpoch: begun.entry.keyEpoch,
  });
  const envelope = await signReceipt(fields, begun.signer);
  const json = envelopeToJson(envelope);
  // The record keeps the version id next to the receipt, so a repeated request gets both back.
  const bytes = Buffer.from(JSON.stringify({ v: 1, receipt: json, archive }));
  const put = await store.putArchiveReceipt(hex(claim.requestId), bytes);
  if (put.status !== 200) return { error: [502, `archive-receipt-write-failed-${put.status}`] };
  return { json, cid: envelopeToDagCbor(envelope).cid, archive };
}

export const tokenDigest = requesterFor;
export { sha256 };
