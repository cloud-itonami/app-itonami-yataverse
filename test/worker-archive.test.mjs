// Leased writes (docs/retention-design.md §3.1, §5; AWAI-3675): a block written with a lease is
// stored under a compliance lock, the locked version is checked, and the answer carries a
// storeClass 3 receipt. The store is a fake with versions and locks; no real bucket is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { TOKEN, ENV, NOW, UNLIMITED } from './worker-fixtures.mjs';
import { lockStore } from './lock-store.mjs';
import { handle, LEASE_HEADER } from '../worker/src/index.mjs';
import { importSigningKey, verifyReceipt, envelopeFromJson, keyIdFor, KEY_USE, STORE_CLASS, ZERO32 } from '../src/receipt.mjs';
import {
  GRADE, leaseFromTerms, signLeaseAsRequester, signLeaseAsVerifier, leaseEnvelopeToDagCbor, receiptCountsFor, inventoryRecord, verifyStatus,
} from '../src/retention.mjs';
import { runVerifierOnce } from '../src/verifier.mjs';
import { makeArchiveProbe } from '../src/archive-probe.mjs';
import { rawCid, cidToBytes } from '../src/cid.mjs';

const hex = (b) => Buffer.from(b).toString('hex');
const fill = (n) => new Uint8Array(32).fill(n);
const T = NOW().getTime(), DAY = 86_400_000;
const BLOCK = Buffer.from('a block someone wants kept'), CID = rawCid(BLOCK);

function key(use) {
  const j = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const jwk = { kty: j.kty, crv: j.crv, d: j.d, x: j.x };
  const keyId = '0x' + hex(keyIdFor(new Uint8Array(Buffer.from(j.x, 'base64url'))));
  return { jwk, entry: { keyId, keyEpoch: 1, alg: 'Ed25519', publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: j.x }, notBefore: 0, notAfter: null, revokedAt: null, ...(use ? { use } : {}) } };
}
const K = { gateway: key(), archive: key([KEY_USE.operatorArchiveReceipt]), verifier: key([KEY_USE.retentionVerifier]), requester: key(), stranger: key([KEY_USE.retentionVerifier]) };
const KEYS = { v: 1, signer: 'did:web:yataverse.com', keys: [K.gateway.entry, K.archive.entry, K.verifier.entry] };
const BASE_ENV = { ...ENV, RECEIPT_SIGNING_KEY: JSON.stringify(K.gateway.jwk), RECEIPT_PUBLIC_KEYS: KEYS,
  WRITE_REQUEST_LIMITER: UNLIMITED, WRITE_MIB_LIMITER: UNLIMITED };
const ARCHIVE_ENV = { ...BASE_ENV, ARCHIVE_RECEIPT_SIGNING_KEY: JSON.stringify(K.archive.jwk), B2_LOCK_KEY_ID: 'lockkid', B2_LOCK_APP_KEY: 'locksecret' };

const signers = {};
async function signer(name) { return (signers[name] ??= await importSigningKey(K[name].jwk)); }
async function leaseEnvFor(over = {}, { verifier = 'verifier', bytes = BLOCK } = {}) {
  const rq = await signer('requester'), vf = await signer(verifier);
  const lease = leaseFromTerms({ subject: cidToBytes(rawCid(bytes)), size: bytes.length, pieceCommitment: ZERO32, grade: GRADE.R1, providerReplicas: 0,
    domainPolicy: fill(3), notBefore: T - 1000, retentionUntil: T + 30 * DAY, challengePeriod: 86_400, requester: rq.keyId, verifier: vf.keyId, policyRevision: fill(4), ...over });
  return { v: 1, lease, sigs: { requester: await signLeaseAsRequester(lease, rq), verifier: await signLeaseAsVerifier(lease, vf) } };
}
const leaseHeader = (env) => Buffer.from(leaseEnvelopeToDagCbor(env).bytes).toString('base64url');
function put(cid, body, leaseEnv, { requestId, header } = {}) {
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.raw' };
  if (leaseEnv || header !== undefined) headers[LEASE_HEADER] = header ?? leaseHeader(leaseEnv);
  if (requestId) headers['yataverse-request-id'] = requestId;
  return new Request(`https://yataverse.com/ipfs/${cid}`, { method: 'PUT', body, headers });
}
const call = (req, env, s) => handle(req, env, { fetchImpl: s.fetchImpl, now: NOW });

test('a leased write locks the block and returns a storeClass 3 receipt that the verifier accepts', async () => {
  const s = lockStore(); const leaseEnv = await leaseEnvFor();
  const res = await call(put(CID, BLOCK, leaseEnv), ARCHIVE_ENV, s);
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json();
  assert.deepEqual(body.archive, { versionId: 'v1', lockMode: 'COMPLIANCE', retainUntil: leaseEnv.lease.retentionUntil });
  const [v] = s.blockVersions(CID);
  assert.deepEqual([v.lockMode, v.retainUntil, v.bytes.toString()], ['COMPLIANCE', leaseEnv.lease.retentionUntil, BLOCK.toString()]);

  // The receipt: signed by the archive key, names the lease, promises what the store reported.
  const r = await verifyReceipt(envelopeFromJson(body.receipt), KEYS, { subject: cidToBytes(CID), size: BLOCK.length });
  assert.equal(r.storeClass, STORE_CLASS.operatorArchive);
  assert.equal('0x' + hex(r.keyId), K.archive.entry.keyId);
  assert.equal(hex(r.leaseId), hex(leaseEnv.lease.leaseId));
  assert.equal(r.retentionUntil, leaseEnv.lease.retentionUntil);
  assert.equal(receiptCountsFor(r, leaseEnv.lease), 'operator-archive');

  // The verifier, looking at the version the write named, finds the lease satisfied.
  const probe = makeArchiveProbe({ endpoint: 'https://s3.us-west-004.backblazeb2.com', bucket: 'bucket', prefix: 'ipld/', keyId: 'lockkid', secret: 'x', fetchImpl: s.fetchImpl, now: NOW });
  const args = { leaseEnv, receiptEnvs: [envelopeFromJson(body.receipt)], keys: KEYS, probe, signer: await signer('verifier'), keyEpoch: 1, now: T + 1000, sampleRead: true };
  const run = await runVerifierOnce({ ...args, versions: { [CID]: body.archive.versionId } });
  assert.equal(run.summary.status, 'policy-satisfied');
  assert.equal(run.summary.checks[0].version, 'v1');
  await verifyStatus(run.status, leaseEnv.lease, KEYS, { now: T + 2000 });

  // An ordinary re-write of the same block adds an unlocked newer version. By name the lock is
  // then invisible; by version the verifier still sees it.
  assert.equal((await call(put(CID, BLOCK), ARCHIVE_ENV, s)).status, 201);
  assert.equal(s.blockVersions(CID).length, 2);
  assert.equal((await runVerifierOnce(args)).summary.checks[0].reason, 'not-locked');
  assert.equal((await runVerifierOnce({ ...args, versions: { [CID]: 'v1' } })).summary.status, 'policy-satisfied');
  assert.equal((await runVerifierOnce({ ...args, versions: { [CID]: s.blockVersions(CID)[1].id } })).summary.checks[0].reason, 'not-locked');
  assert.equal((await runVerifierOnce({ ...args, versions: { [CID]: 'no-such-version' } })).summary.checks[0].reason, 'object-missing');
});

test('a write without a lease is unchanged: no lock header, a gateway receipt', async () => {
  const s = lockStore();
  const res = await call(put(CID, BLOCK), ARCHIVE_ENV, s);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.archive, undefined);
  assert.equal(body.receipt.receipt.storeClass, STORE_CLASS.edgeGateway);
  assert.equal(body.receipt.receipt.retentionUntil, 0);
  assert.ok(s.log.every((r) => r.lock === null && r.cred === 'kid'));
  assert.equal(s.lockedVersions().length, 0);
});

test('a leased write is refused, and nothing is stored, when the request should not be locked', async () => {
  const cases = [
    ['archive-not-configured', 503, await leaseEnvFor(), BASE_ENV],
    ['archive-not-configured', 503, await leaseEnvFor(), { ...ARCHIVE_ENV, B2_LOCK_APP_KEY: '' }],
    ['archive-not-configured', 503, await leaseEnvFor(), { ...ARCHIVE_ENV, ARCHIVE_RECEIPT_SIGNING_KEY: '' }],
    // The archive signing key must be published, and published for that use.
    ['archive-receipt-key-not-published', 503, await leaseEnvFor(), { ...ARCHIVE_ENV, RECEIPT_PUBLIC_KEYS: { ...KEYS, keys: [K.gateway.entry, K.verifier.entry] } }],
    ['archive-receipt-key-not-allowed', 503, await leaseEnvFor(), { ...ARCHIVE_ENV, ARCHIVE_RECEIPT_SIGNING_KEY: JSON.stringify(K.gateway.jwk) }],
    ['archive-receipt-key-not-valid-now', 503, await leaseEnvFor(), { ...ARCHIVE_ENV, RECEIPT_PUBLIC_KEYS: { ...KEYS, keys: [K.gateway.entry, { ...K.archive.entry, revokedAt: T }, K.verifier.entry] } }],
    // The lease.
    ['lease-unknown-key', 400, await leaseEnvFor({}, { verifier: 'stranger' }), ARCHIVE_ENV],
    ['lease-key-is-not-a-retention-verifier', 400, await leaseEnvFor({}, { verifier: 'gateway' }), ARCHIVE_ENV],
    ['lease-subject-is-not-this-block', 400, await leaseEnvFor({}, { bytes: Buffer.from('another block of equal len') }), ARCHIVE_ENV],
    ['lease-subject-is-not-this-block', 400, await leaseEnvFor({ subject: inventoryRecord([CID, rawCid(Buffer.from('b'))]).commitment }), ARCHIVE_ENV],
    ['lease-size-mismatch', 400, await leaseEnvFor({ size: BLOCK.length + 1 }), ARCHIVE_ENV],
    ['lease-expired', 400, await leaseEnvFor({ notBefore: T - 2 * DAY, retentionUntil: T }), ARCHIVE_ENV],
    ['lease-not-started', 400, await leaseEnvFor({ notBefore: T + DAY, retentionUntil: T + 30 * DAY }), ARCHIVE_ENV],
    // A compliance lock cannot be undone, so its length is capped (90 days unless configured).
    ['lease-longer-than-the-lock-limit', 400, await leaseEnvFor({ retentionUntil: T + 91 * DAY }), ARCHIVE_ENV],
    ['lease-longer-than-the-lock-limit', 400, await leaseEnvFor({ retentionUntil: T + 8 * DAY }), { ...ARCHIVE_ENV, ARCHIVE_MAX_LOCK_DAYS: '7' }],
  ];
  for (const [code, status, leaseEnv, env] of cases) {
    const s = lockStore();
    const res = await call(put(CID, BLOCK, leaseEnv), env, s);
    assert.equal(res.status, status, code);
    assert.equal((await res.json()).error, code);
    assert.equal(s.blockVersions(CID).length, 0, `${code}: nothing stored`);
    assert.ok(s.log.every((r) => r.method !== 'PUT'), `${code}: no write at all`);
  }
  // Tampered and malformed lease headers.
  const good = await leaseEnvFor();
  const flipped = { ...good, sigs: { ...good.sigs, requester: { ...good.sigs.requester, sig: (() => { const b = new Uint8Array(good.sigs.requester.sig); b[0] ^= 1; return b; })() } } };
  for (const [code, req] of [
    ['lease-bad-requester-signature', put(CID, BLOCK, flipped)],
    ['lease-lease-id-mismatch', put(CID, BLOCK, { ...good, lease: { ...good.lease, retentionUntil: good.lease.retentionUntil + DAY } })],
    ['bad-lease-header', put(CID, BLOCK, null, { header: 'not base64url!' })],
    ['lease-record-not-dag-cbor', put(CID, BLOCK, null, { header: Buffer.from('ff'.repeat(16), 'hex').toString('base64url') })],
  ]) {
    const s = lockStore();
    const res = await call(req, ARCHIVE_ENV, s);
    assert.equal(res.status, 400, code); assert.equal((await res.json()).error, code);
    assert.equal(s.objects.size, 0, `${code}: nothing stored`);
  }
  // A longer limit can be configured.
  const s = lockStore();
  assert.equal((await call(put(CID, BLOCK, await leaseEnvFor({ retentionUntil: T + 120 * DAY })), { ...ARCHIVE_ENV, ARCHIVE_MAX_LOCK_DAYS: '365' }, s)).status, 201);
});

test('no receipt is issued when the stored version does not check out', async () => {
  for (const [mode, code] of [
    ['lock-write-fails', 'archive-write-failed-403'],
    ['no-version', 'archive-write-returned-no-version'],
    ['lock-ignored', 'archive-version-not-locked'],
    ['lock-short', 'archive-lock-ends-before-the-lease'],
    ['corrupt-locked', 'archive-version-size-mismatch'],
  ]) {
    const s = lockStore({ mode });
    const res = await call(put(CID, BLOCK, await leaseEnvFor()), ARCHIVE_ENV, s);
    assert.equal(res.status, 502, mode);
    const body = await res.json();
    assert.equal(body.error, code);
    assert.equal(body.receipt, undefined);
    assert.ok(![...s.objects.keys()].some((k) => k.startsWith('ipld/receipts/archive/')), `${mode}: no archive receipt stored`);
  }
});

test('a repeated leased request returns the same receipt without locking again; other content conflicts', async () => {
  const s = lockStore(); const leaseEnv = await leaseEnvFor(); const rid = 'ab'.repeat(32);
  const first = await (await call(put(CID, BLOCK, leaseEnv, { requestId: rid }), ARCHIVE_ENV, s)).json();
  const second = await (await call(put(CID, BLOCK, leaseEnv, { requestId: rid }), ARCHIVE_ENV, s)).json();
  assert.deepEqual(second.receipt, first.receipt);
  assert.equal(second.receiptCid, first.receiptCid);
  assert.deepEqual(second.archive, first.archive);
  assert.equal(s.lockedVersions().length, 1, 'the block was locked once');
  // The same request id for another lease on the same block is a conflict, and locks nothing more.
  const otherLease = await leaseEnvFor({ retentionUntil: T + 10 * DAY });
  const res = await call(put(CID, BLOCK, otherLease, { requestId: rid }), ARCHIVE_ENV, s);
  assert.equal(res.status, 409); assert.equal((await res.json()).error, 'request-id-conflict');
  assert.equal(s.lockedVersions().length, 1);
  // The gateway's own receipt namespace is separate: an ordinary write with that id still works.
  assert.equal((await call(put(CID, BLOCK, null, { requestId: rid }), ARCHIVE_ENV, s)).status, 201);
});
