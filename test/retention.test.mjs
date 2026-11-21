// Retention lease and status (docs/retention-design.md §3–§6, AWAI-3670): types, signing,
// verification, and the store-class rules added to storage receipts. No store or network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  KIND, STATE, STORE_CLASS, KEY_USE, keyUses, importSigningKey, signReceipt, verifyReceipt, ReceiptError, ZERO32,
} from '../src/receipt.mjs';
import {
  LEASE_FIELDS, LEASE_TYPE_STRING, STATUS_FIELDS, STATUS_TYPE_STRING, GRADE, STATUS, RetentionError,
  leaseFromTerms, leaseIdFor, leaseDigest, checkLease, signLeaseAsRequester, signLeaseAsVerifier, verifyLease,
  leaseEnvelopeToJson, leaseEnvelopeFromJson, leaseEnvelopeToDagCbor, leaseEnvelopeFromDagCbor,
  inventoryRecord, statusDigest, signStatus, verifyStatus, gradeSatisfied,
  statusEnvelopeToJson, statusEnvelopeFromJson, statusEnvelopeToDagCbor, statusEnvelopeFromDagCbor, receiptCountsFor,
} from '../src/retention.mjs';
import { rawCid, cidToBytes } from '../src/cid.mjs';
import { verifyReceiptInput } from '../src/verify-receipt.mjs';
import { envelopeToJson } from '../src/receipt.mjs';

const hex = (b) => Buffer.from(b).toString('hex');
const sha256 = (b) => new Uint8Array(crypto.createHash('sha256').update(b).digest());
const fill = (n) => new Uint8Array(32).fill(n);

function newKeyJwk() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const j = privateKey.export({ format: 'jwk' });
  return { kty: j.kty, crv: j.crv, d: j.d, x: j.x };
}
const keyEntry = (signer, jwk, extra = {}) => ({ keyId: '0x' + hex(signer.keyId), keyEpoch: 1, alg: 'Ed25519',
  publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, notBefore: 0, notAfter: null, revokedAt: null, ...extra });
const keySet = (...entries) => ({ v: 1, signer: 'did:web:yataverse.com', keys: entries });

const T0 = 1_800_000_000_000;            // lease start (Unix ms)
const DAY = 86_400_000;
const BLOCK = Buffer.from('retention test block');
const CID = rawCid(BLOCK);

async function parties() {
  const jwks = { requester: newKeyJwk(), verifier: newKeyJwk(), gateway: newKeyJwk(), archive: newKeyJwk(), provider: newKeyJwk(), other: newKeyJwk() };
  const s = {};
  for (const [k, j] of Object.entries(jwks)) s[k] = await importSigningKey(j);
  const keys = keySet(
    keyEntry(s.verifier, jwks.verifier, { use: [KEY_USE.retentionVerifier] }),
    keyEntry(s.gateway, jwks.gateway),                                              // no `use`: gateway receipts only
    keyEntry(s.archive, jwks.archive, { use: [KEY_USE.operatorArchiveReceipt] }),
    keyEntry(s.provider, jwks.provider, { use: [KEY_USE.providerReceipt] }),
  );
  return { jwks, s, keys };
}

const termsFor = (s, over = {}) => ({
  subject: cidToBytes(CID), size: BLOCK.length, pieceCommitment: fill(7), grade: GRADE.R2, providerReplicas: 1,
  domainPolicy: fill(3), notBefore: T0, retentionUntil: T0 + 90 * DAY, challengePeriod: 86_400,
  requester: s.requester.keyId, verifier: s.verifier.keyId, policyRevision: fill(4), ...over,
});
const r1Terms = (s, over = {}) => termsFor(s, { grade: GRADE.R1, providerReplicas: 0, pieceCommitment: ZERO32, ...over });

async function signedLease(s, terms) {
  const lease = leaseFromTerms(terms);
  return { v: 1, lease, sigs: { requester: await signLeaseAsRequester(lease, s.requester), verifier: await signLeaseAsVerifier(lease, s.verifier) } };
}
const rejects = (p, code) => assert.rejects(p, (e) => (e instanceof RetentionError || e instanceof ReceiptError) && e.code === code, code);
const throwsCode = (f, code) => assert.throws(f, (e) => e instanceof RetentionError && e.code === code, code);

test('the lease and status types are the ones the design names', () => {
  assert.equal(LEASE_TYPE_STRING, 'YataverseRetentionLease(bytes32 leaseId,bytes subject,uint64 size,bytes32 pieceCommitment,uint8 grade,' +
    'uint8 providerReplicas,bytes32 domainPolicy,uint64 notBefore,uint64 retentionUntil,uint32 challengePeriod,bytes32 requester,bytes32 verifier,bytes32 policyRevision)');
  assert.equal(STATUS_TYPE_STRING, 'YataverseRetentionStatus(bytes32 leaseId,bytes subject,uint8 grade,uint8 status,uint8 providerReplicas,' +
    'uint8 operatorCopies,bytes32 evidenceRoot,uint64 observedAt,uint64 validUntil,bytes32 keyId,uint32 keyEpoch)');
});

test('a lease id depends on every term and on nothing else', async () => {
  const { s } = await parties();
  const terms = termsFor(s);
  const lease = leaseFromTerms(terms);
  assert.equal(hex(lease.leaseId), hex(leaseIdFor(terms)));
  assert.equal(hex(leaseFromTerms({ ...terms, leaseId: fill(9) }).leaseId), hex(lease.leaseId), 'a leaseId passed in is ignored');
  assert.equal(hex(leaseFromTerms({ ...terms }).leaseId), hex(lease.leaseId), 'the same terms give the same id');
  for (const [n, t] of LEASE_FIELDS) {
    if (n === 'leaseId') continue;
    const changed = { ...terms };
    if (t.startsWith('uint')) changed[n] = terms[n] + 1; else { changed[n] = new Uint8Array(terms[n]); changed[n][0] ^= 1; }
    assert.notEqual(hex(leaseIdFor(changed)), hex(lease.leaseId), n);
  }
  // A lease that carries someone else's id is refused before anything is signed.
  throwsCode(() => leaseDigest({ ...lease, leaseId: fill(9) }), 'lease-id-mismatch');
});

test('lease terms must fit the grade', async () => {
  const { s } = await parties();
  checkLease(leaseFromTerms(r1Terms(s)));
  checkLease(leaseFromTerms(termsFor(s, { grade: GRADE.R3, providerReplicas: 3 })));
  throwsCode(() => leaseFromTerms(termsFor(s, { grade: 4 })), 'unknown-grade');
  throwsCode(() => leaseFromTerms(r1Terms(s, { providerReplicas: 1 })), 'r1-with-provider-replicas');
  throwsCode(() => leaseFromTerms(r1Terms(s, { pieceCommitment: fill(7) })), 'r1-with-piece-commitment');
  throwsCode(() => leaseFromTerms(termsFor(s, { providerReplicas: 0 })), 'r2-needs-a-provider-replica');
  throwsCode(() => leaseFromTerms(termsFor(s, { pieceCommitment: ZERO32 })), 'piece-commitment-missing');
  throwsCode(() => leaseFromTerms(termsFor(s, { grade: GRADE.R3, providerReplicas: 2 })), 'r3-needs-three-provider-replicas');
  throwsCode(() => leaseFromTerms(termsFor(s, { retentionUntil: T0 })), 'retention-does-not-follow-not-before');
  throwsCode(() => leaseFromTerms(termsFor(s, { challengePeriod: 0 })), 'challenge-period-is-zero');
  throwsCode(() => leaseFromTerms(termsFor(s, { size: 0 })), 'size-is-zero');
  throwsCode(() => leaseFromTerms(termsFor(s, { verifier: ZERO32 })), 'verifier-is-zero');
  throwsCode(() => leaseFromTerms({ ...termsFor(s), extra: 1 }), 'lease-fields-do-not-match');
});

test('a lease needs both signatures, from the parties it names', async () => {
  const { jwks, s, keys } = await parties();
  const env = await signedLease(s, termsFor(s));
  const lease = await verifyLease(env, keys);
  assert.equal(hex(lease.leaseId), hex(env.lease.leaseId));

  await rejects(verifyLease({ ...env, sigs: { verifier: env.sigs.verifier } }, keys), 'requester-signature-missing');
  await rejects(verifyLease({ ...env, sigs: { requester: env.sigs.requester } }, keys), 'verifier-signature-missing');
  // Tampering with any term changes the id, so it is caught before the signatures are looked at.
  await rejects(verifyLease({ ...env, lease: { ...env.lease, retentionUntil: env.lease.retentionUntil + DAY } }, keys), 'lease-id-mismatch');
  // Terms changed and the id recomputed to match: now the signatures no longer cover it.
  const longer = leaseFromTerms({ ...termsFor(s), retentionUntil: T0 + 3000 * DAY });
  await rejects(verifyLease({ ...env, lease: longer }, keys), 'bad-requester-signature');
  const flip = (sig) => { const b = new Uint8Array(sig); b[0] ^= 1; return b; };
  await rejects(verifyLease({ ...env, sigs: { ...env.sigs, requester: { ...env.sigs.requester, sig: flip(env.sigs.requester.sig) } } }, keys), 'bad-requester-signature');
  await rejects(verifyLease({ ...env, sigs: { ...env.sigs, verifier: { ...env.sigs.verifier, sig: flip(env.sigs.verifier.sig) } } }, keys), 'bad-verifier-signature');
  // Another key signing in the requester's place.
  const forged = { alg: 'Ed25519', publicKey: s.other.publicKey, sig: new Uint8Array(await crypto.webcrypto.subtle.sign('Ed25519', s.other.privateKey, leaseDigest(env.lease))) };
  await rejects(verifyLease({ ...env, sigs: { ...env.sigs, requester: forged } }, keys), 'requester-key-does-not-match-lease');
  await rejects(signLeaseAsRequester(env.lease, s.other), 'lease-requester-is-not-the-signer');
  await rejects(signLeaseAsVerifier(env.lease, s.other), 'lease-verifier-is-not-the-signer');

  // The verifier's key must be published, allowed to verify, and valid when the lease starts.
  await rejects(verifyLease(env, keySet()), 'unknown-key');
  await rejects(verifyLease(env, keySet(keyEntry(s.verifier, jwks.verifier))), 'key-is-not-a-retention-verifier');
  await rejects(verifyLease(env, keySet(keyEntry(s.verifier, jwks.verifier, { use: [KEY_USE.operatorArchiveReceipt] }))), 'key-is-not-a-retention-verifier');
  const asVerifier = (extra) => keySet(keyEntry(s.verifier, jwks.verifier, { use: [KEY_USE.retentionVerifier], ...extra }));
  await rejects(verifyLease(env, asVerifier({ notBefore: T0 + 1 })), 'before-key-valid');
  await rejects(verifyLease(env, asVerifier({ notAfter: T0 })), 'after-key-expired');
  await rejects(verifyLease(env, asVerifier({ revokedAt: T0 })), 'key-revoked');
  await verifyLease(env, asVerifier({ revokedAt: T0 + 1 }));          // revoked after the lease started: the lease stands
  await rejects(verifyLease(env, keySet(keyEntry(s.verifier, { ...jwks.verifier, x: jwks.other.x }, { use: [KEY_USE.retentionVerifier] }))), 'published-key-does-not-match-key-id');
});

test('lease envelopes survive JSON and DAG-CBOR', async () => {
  const { s, keys } = await parties();
  const env = await signedLease(s, termsFor(s));
  const viaJson = leaseEnvelopeFromJson(JSON.parse(JSON.stringify(leaseEnvelopeToJson(env))));
  await verifyLease(viaJson, keys);
  const { bytes, cid } = leaseEnvelopeToDagCbor(env);
  await verifyLease(leaseEnvelopeFromDagCbor(bytes), keys);
  assert.equal(leaseEnvelopeToDagCbor(viaJson).cid, cid, 'the record is canonical');
  throwsCode(() => leaseEnvelopeFromJson({ ...leaseEnvelopeToJson(env), lease: { ...leaseEnvelopeToJson(env).lease, extra: 1 } }), 'unknown-field:extra');
  throwsCode(() => leaseEnvelopeFromDagCbor(Uint8Array.of(0xff)), 'record-not-dag-cbor');
  throwsCode(() => leaseEnvelopeFromDagCbor(Buffer.from('not cbor at all')), 'not-a-v1-record');   // valid CBOR, wrong shape
});

test('an inventory commitment does not depend on order or repeats', () => {
  const a = rawCid(Buffer.from('a')), b = rawCid(Buffer.from('b')), c = rawCid(Buffer.from('c'));
  const one = inventoryRecord([a, b, c]);
  assert.equal(hex(inventoryRecord([c, a, b, a]).commitment), hex(one.commitment));
  assert.equal(hex(sha256(one.bytes)), hex(one.commitment));
  assert.notEqual(hex(inventoryRecord([a, b]).commitment), hex(one.commitment));
  throwsCode(() => inventoryRecord([]), 'inventory-is-empty');
  throwsCode(() => inventoryRecord(['not-a-cid']), 'cid-not-cidv1');
});

async function statusFor(s, lease, over = {}) {
  return signStatus({ leaseId: lease.leaseId, subject: lease.subject, grade: lease.grade, status: STATUS.policySatisfied,
    providerReplicas: 1, operatorCopies: 1, evidenceRoot: fill(5), observedAt: T0 + DAY, validUntil: T0 + 2 * DAY,
    keyId: s.verifier.keyId, keyEpoch: 1, ...over }, s.verifier);
}

test('a status is believed only from the lease verifier, about that lease, while it is fresh', async () => {
  const { jwks, s, keys } = await parties();
  const lease = (await signedLease(s, termsFor(s))).lease;
  const env = await statusFor(s, lease);
  const now = T0 + DAY + 1000;
  const st = await verifyStatus(env, lease, keys, { now });
  assert.equal(st.status, STATUS.policySatisfied);

  await rejects(verifyStatus(env, lease, keys, {}), 'now-required');
  // Freshness: past validUntil the state is unknown, not "still satisfied".
  await rejects(verifyStatus(env, lease, keys, { now: T0 + 2 * DAY }), 'status-stale');
  await verifyStatus(env, lease, keys, { now: T0 + 2 * DAY - 1 });
  await rejects(verifyStatus(env, lease, keys, { now: T0 }), 'status-from-the-future');
  // A verifier may not make a status last longer than two challenge periods.
  await rejects(verifyStatus(await statusFor(s, lease, { validUntil: T0 + 3 * DAY + 1 }), lease, keys, { now }), 'status-valid-for-too-long');
  await verifyStatus(await statusFor(s, lease, { validUntil: T0 + 3 * DAY }), lease, keys, { now });

  // Tampering and other signers.
  await rejects(verifyStatus({ ...env, status: { ...env.status, providerReplicas: 2 } }, lease, keys, { now }), 'bad-signature');
  const flipped = new Uint8Array(env.sig.sig); flipped[0] ^= 1;
  await rejects(verifyStatus({ ...env, sig: { ...env.sig, sig: flipped } }, lease, keys, { now }), 'bad-signature');
  // A published gateway key, correctly signing a status, is not this lease's verifier.
  const byGateway = await signStatus({ ...env.status, keyId: s.gateway.keyId }, s.gateway);
  await rejects(verifyStatus(byGateway, lease, keys, { now }), 'status-not-from-the-lease-verifier');
  // Even if a lease named the gateway key as verifier, that key is not allowed to verify.
  const leaseNamingGateway = leaseFromTerms(termsFor(s, { verifier: s.gateway.keyId }));
  const byGateway2 = await signStatus({ ...env.status, leaseId: leaseNamingGateway.leaseId, keyId: s.gateway.keyId }, s.gateway);
  await rejects(verifyStatus(byGateway2, leaseNamingGateway, keys, { now }), 'key-is-not-a-retention-verifier');
  await rejects(signStatus({ ...env.status, keyId: s.other.keyId }, s.verifier), 'status-key-id-is-not-the-signer');

  // Key validity is judged at observedAt.
  const asVerifier = (extra) => keySet(keyEntry(s.verifier, jwks.verifier, { use: [KEY_USE.retentionVerifier], ...extra }));
  await rejects(verifyStatus(env, lease, asVerifier({ revokedAt: T0 + DAY }), { now }), 'key-revoked');
  await rejects(verifyStatus(env, lease, asVerifier({ notAfter: T0 + DAY }), { now }), 'after-key-expired');
  await rejects(verifyStatus(env, lease, asVerifier({ keyEpoch: 2 }), { now }), 'key-epoch-mismatch');

  // It must be about this lease.
  const otherLease = leaseFromTerms(termsFor(s, { retentionUntil: T0 + 30 * DAY }));
  await rejects(verifyStatus(env, otherLease, keys, { now }), 'lease-id-mismatch');
  await rejects(verifyStatus(await statusFor(s, lease, { subject: cidToBytes(rawCid(Buffer.from('x'))) }), lease, keys, { now }), 'subject-mismatch');
  await rejects(verifyStatus(await statusFor(s, lease, { grade: GRADE.R1 }), lease, keys, { now }), 'grade-mismatch');
});

test('policy-satisfied must follow from the copies counted and the lease term', async () => {
  const { s, keys } = await parties();
  const now = T0 + DAY + 1000;
  const r2 = leaseFromTerms(termsFor(s));
  await rejects(verifyStatus(await statusFor(s, r2, { operatorCopies: 0 }), r2, keys, { now }), 'satisfied-without-the-required-copies');
  await rejects(verifyStatus(await statusFor(s, r2, { providerReplicas: 0 }), r2, keys, { now }), 'satisfied-without-the-required-copies');
  // The same counts are fine when the verifier says "degraded".
  const degraded = await verifyStatus(await statusFor(s, r2, { providerReplicas: 0, status: STATUS.degraded }), r2, keys, { now });
  assert.equal(degraded.status, STATUS.degraded);

  const r1 = leaseFromTerms(r1Terms(s));
  await verifyStatus(await statusFor(s, r1, { providerReplicas: 0 }), r1, keys, { now });
  await rejects(verifyStatus(await statusFor(s, r1, { providerReplicas: 0, operatorCopies: 0 }), r1, keys, { now }), 'satisfied-without-the-required-copies');

  const r3 = leaseFromTerms(termsFor(s, { grade: GRADE.R3, providerReplicas: 3 }));
  await verifyStatus(await statusFor(s, r3, { providerReplicas: 3, operatorCopies: 0 }), r3, keys, { now });
  // Two provider nodes and the operator archive do not add up to R3: the kinds are counted apart.
  await rejects(verifyStatus(await statusFor(s, r3, { providerReplicas: 2, operatorCopies: 1 }), r3, keys, { now }), 'satisfied-without-the-required-copies');
  assert.equal(gradeSatisfied(r3, { providerReplicas: 2, operatorCopies: 5 }), false);

  // Outside the term.
  const end = r2.retentionUntil;
  await rejects(verifyStatus(await statusFor(s, r2, { observedAt: end, validUntil: end + DAY }), r2, keys, { now: end + 1 }), 'satisfied-outside-the-lease-term');
  await rejects(verifyStatus(await statusFor(s, r2, { status: STATUS.expired }), r2, keys, { now }), 'expired-before-retention-until');
  await verifyStatus(await statusFor(s, r2, { status: STATUS.expired, observedAt: end, validUntil: end + DAY }), r2, keys, { now: end + 1 });
  await rejects(signStatus({ ...(await statusFor(s, r2)).status, status: 11 }, s.verifier), 'unknown-status');
  await rejects(signStatus({ ...(await statusFor(s, r2)).status, validUntil: T0 + DAY }, s.verifier), 'valid-until-does-not-follow-observed-at');
});

test('status envelopes survive JSON and DAG-CBOR', async () => {
  const { s, keys } = await parties();
  const lease = leaseFromTerms(termsFor(s));
  const env = await statusFor(s, lease);
  const now = T0 + DAY + 1;
  await verifyStatus(statusEnvelopeFromJson(JSON.parse(JSON.stringify(statusEnvelopeToJson(env)))), lease, keys, { now });
  const { bytes, cid } = statusEnvelopeToDagCbor(env);
  await verifyStatus(statusEnvelopeFromDagCbor(bytes), lease, keys, { now });
  assert.equal(statusEnvelopeToDagCbor(statusEnvelopeFromJson(statusEnvelopeToJson(env))).cid, cid);
  assert.equal(hex(statusDigest(env.status)).length, 64);
});

// --- Storage receipts: what each store class may promise, and which key may sign it ---

const receiptBase = (signer, over = {}) => ({
  kind: KIND.block, subject: cidToBytes(CID), size: BLOCK.length, contentDigest: sha256(BLOCK), requestId: fill(1), requester: fill(2),
  reservationId: ZERO32, leaseId: ZERO32, pieceCommitment: ZERO32, policyRevision: fill(4), state: STATE.localDurableReadback,
  storeClass: STORE_CLASS.edgeGateway, acceptedAt: T0 + 1000, retentionUntil: 0, keyId: signer.keyId, keyEpoch: 1, ...over,
});

test('a key entry without `use` is a gateway receipt key only', () => {
  assert.deepEqual(keyUses({}), [KEY_USE.gatewayReceipt]);
  assert.deepEqual(keyUses({ use: [KEY_USE.retentionVerifier] }), [KEY_USE.retentionVerifier]);
  assert.deepEqual(keyUses({ use: 'retention-verifier' }), [KEY_USE.gatewayReceipt], 'a malformed use grants nothing extra');
});

test('gateway receipts verify as before and may not promise retention', async () => {
  const { s, keys } = await parties();
  const r = await verifyReceipt(await signReceipt(receiptBase(s.gateway), s.gateway), keys);
  assert.equal(r.storeClass, STORE_CLASS.edgeGateway);
  await rejects(verifyReceipt(await signReceipt(receiptBase(s.gateway, { retentionUntil: T0 + 90 * DAY }), s.gateway), keys), 'gateway-claims-retention');
  await rejects(verifyReceipt(await signReceipt(receiptBase(s.gateway, { state: STATE.policySatisfied }), s.gateway), keys), 'gateway-claims-policy-satisfied');
});

test('operator-archive and provider receipts need a lease, a term, and a key allowed for that class', async () => {
  const { s, keys } = await parties();
  const lease = leaseFromTerms(termsFor(s));
  const archive = (over = {}) => receiptBase(s.archive, { storeClass: STORE_CLASS.operatorArchive, leaseId: lease.leaseId, retentionUntil: lease.retentionUntil, ...over });
  const provider = (over = {}) => receiptBase(s.provider, { storeClass: STORE_CLASS.providerNode, leaseId: lease.leaseId, retentionUntil: lease.retentionUntil, pieceCommitment: lease.pieceCommitment, ...over });

  const ra = await verifyReceipt(await signReceipt(archive(), s.archive), keys);
  const rp = await verifyReceipt(await signReceipt(provider(), s.provider), keys);
  assert.equal(receiptCountsFor(ra, lease), 'operator-archive');
  assert.equal(receiptCountsFor(rp, lease), 'provider-node');

  // The gateway key (no `use`) cannot sign a retention promise, and the archive key cannot sign for a provider.
  await rejects(verifyReceipt(await signReceipt({ ...archive(), keyId: s.gateway.keyId }, s.gateway), keys), 'key-not-allowed-for-store-class');
  await rejects(verifyReceipt(await signReceipt({ ...provider(), keyId: s.archive.keyId }, s.archive), keys), 'key-not-allowed-for-store-class');
  await rejects(verifyReceipt(await signReceipt({ ...receiptBase(s.archive) }, s.archive), keys), 'key-not-allowed-for-store-class');
  // The verifier key cannot sign receipts at all.
  await rejects(verifyReceipt(await signReceipt({ ...archive(), keyId: s.verifier.keyId }, s.verifier), keys), 'key-not-allowed-for-store-class');

  await rejects(verifyReceipt(await signReceipt(archive({ leaseId: ZERO32 }), s.archive), keys), 'retention-receipt-without-lease');
  await rejects(verifyReceipt(await signReceipt(archive({ retentionUntil: 0 }), s.archive), keys), 'retention-does-not-follow-accepted-at');
  await rejects(verifyReceipt(await signReceipt(archive({ retentionUntil: T0 + 1000 }), s.archive), keys), 'retention-does-not-follow-accepted-at');
  await rejects(verifyReceipt(await signReceipt(archive({ pieceCommitment: fill(7) }), s.archive), keys), 'operator-archive-with-piece-commitment');
  await rejects(verifyReceipt(await signReceipt(provider({ pieceCommitment: ZERO32 }), s.provider), keys), 'provider-receipt-without-piece-commitment');
  // No receipt, of any class, may claim policy-satisfied.
  await rejects(verifyReceipt(await signReceipt(archive({ state: STATE.policySatisfied }), s.archive), keys), 'gateway-claims-policy-satisfied');
  await rejects(verifyReceipt(await signReceipt(provider({ state: STATE.policySatisfied }), s.provider), keys), 'gateway-claims-policy-satisfied');

  // Counting towards a lease.
  const gw = await verifyReceipt(await signReceipt(receiptBase(s.gateway), s.gateway), keys);
  throwsCode(() => receiptCountsFor(gw, lease), 'gateway-receipt-is-not-counted');
  const otherLease = leaseFromTerms(termsFor(s, { retentionUntil: T0 + 30 * DAY }));
  throwsCode(() => receiptCountsFor(ra, otherLease), 'receipt-is-for-another-lease');
  const shortA = await verifyReceipt(await signReceipt(archive({ retentionUntil: lease.retentionUntil - 1 }), s.archive), keys);
  throwsCode(() => receiptCountsFor(shortA, lease), 'receipt-promises-less-than-the-lease');
  const wrongPiece = await verifyReceipt(await signReceipt(provider({ pieceCommitment: fill(8) }), s.provider), keys);
  throwsCode(() => receiptCountsFor(wrongPiece, lease), 'piece-commitment-mismatch');
  const r1 = leaseFromTerms(r1Terms(s));
  const forR1 = await verifyReceipt(await signReceipt(provider({ leaseId: r1.leaseId }), s.provider), keys);
  throwsCode(() => receiptCountsFor(forR1, r1), 'r1-lease-has-no-provider-node');
});

test('verify-receipt reports the store class and what it claims', async () => {
  const { s, keys } = await parties();
  const lease = leaseFromTerms(r1Terms(s));
  const env = await signReceipt(receiptBase(s.archive, { storeClass: STORE_CLASS.operatorArchive, leaseId: lease.leaseId, retentionUntil: lease.retentionUntil }), s.archive);
  const out = await verifyReceiptInput(envelopeToJson(env), keys, { file: BLOCK, kind: 'block' });
  assert.equal(out.storeClass, 'operator-archive');
  assert.equal(out.leaseId, '0x' + hex(lease.leaseId));
  assert.equal(out.retentionUntil, new Date(lease.retentionUntil).toISOString());
  assert.match(out.claims, /not an independent replica/);
  const gw = await verifyReceiptInput(envelopeToJson(await signReceipt(receiptBase(s.gateway), s.gateway)), keys, { file: BLOCK, kind: 'block' });
  assert.equal(gw.storeClass, 'edge-gateway');
  assert.equal(gw.leaseId, undefined);
  assert.match(gw.claims, /not retention or independent replicas/);
});
