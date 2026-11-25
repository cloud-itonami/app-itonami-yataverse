// Negative controls for the signed-statement registry protocol (fake storage).
// Each test names the hole it controls; every test in this file fails on
// 61596fe (recorded pre-fix) and passes on the fixed head. Fake storage only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { handle } from '../worker/src/index.mjs';
import { MemoryRegistry, RECOVERY_WAIT_MS } from '../worker/src/e2ee-registry.mjs';
import { deriveFromSeed } from '../src/recovery-derivation.mjs';
import { keyFromSeed, newSeed, mintDirect, e2eeGetResource, e2eePutResource, e2eeHeadResource } from '../src/cacao.mjs';
import { ENV, NOW, fakeStore } from './worker-fixtures.mjs';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const packBytes = () => fs.readFileSync(new URL('./fixtures/drive-v1.car', import.meta.url));
const T0 = NOW().getTime();
const WRITER = keyFromSeed(newSeed());
const BASE = { ...ENV, CACAO_NONCE_SECRET: 'test-nonce-secret-0123456789abcdef', CACAO_AUD: 'https://yataverse.com',
               CACAO_DOMAIN: 'yataverse.com', CACAO_WRITER_DIDS: WRITER.did };
const SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const DERIVED = deriveFromSeed(SEED);
const OWNER = DERIVED.owner;
const DEVICE = keyFromSeed(newSeed());
let regNow = T0;
const registry = () => new MemoryRegistry({ now: () => regNow });
const DAY = 24 * 60 * 60 * 1000;

const envFor = (owner = OWNER) => ({ ...BASE, E2EE_OWNER_ALLOWLIST: owner });
const deps = (s, r) => ({ fetchImpl: s.fetchImpl, now: NOW, e2eeRegistry: r });
const post = (action, body, s, r, env = envFor()) => handle(new Request(
  `https://yataverse.com/awai-drive/v1/e2ee-registry/${action}`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, deps(s, r));

test('control 1: unsigned cancel/revoke are rejected and change nothing', async () => {
  regNow = T0;
  const s = fakeStore(); const r = registry();
  // Seed-register one device directly at registry level for setup.
  await r.applyRegistration({ owner: OWNER, deviceDid: DEVICE.did, approverDid: DERIVED.registration.did, kind: 'seed' });
  const rv = await post('revoke', { owner: OWNER, actorDid: DEVICE.did, targetDid: DEVICE.did }, s, r);
  assert.equal(rv.status, 401, 'revoke without actor signature must be 401');
  assert.equal(await r.ownerOfDevice(DEVICE.did), OWNER, 'device must still be registered');
  const cc = await post('cancel', { owner: OWNER, actorDid: DEVICE.did, pendingId: 1 }, s, r);
  assert.equal(cc.status, 401, 'cancel without actor signature must be 401');
});

test('control 2: registration without the new device consent signature is rejected', async () => {
  regNow = T0;
  const s = fakeStore(); const r = registry();
  // A fully valid approver signature under the OLD scheme, but no device
  // consent signature: old code admits, fixed code must answer 401.
  const oldMsg = `yataverse:e2ee:register:${OWNER}:${DEVICE.did}:${DERIVED.registration.did}`;
  const goodApproverSig = crypto.sign(null, Buffer.from(oldMsg, 'utf8'),
    DERIVED.registration.privateKey).toString('base64url');
  const body = { owner: OWNER, deviceDid: DEVICE.did, approval: { kind: 'seed', approverDid: DERIVED.registration.did,
    signature: goodApproverSig } };
  const res = await post('register', body, s, r);
  assert.equal(res.status, 401, 'approver-only approval must be 401');
  assert.equal(await r.ownerOfDevice(DEVICE.did), null);
});

test('control 3: owner is sha256(prefix || registration public key), not an HKDF row', () => {
  const d = deriveFromSeed(SEED);
  const want = crypto.createHash('sha256')
    .update(Buffer.concat([Buffer.from('awai-drive/v1/owner', 'utf8'), d.registration.publicRaw])).digest('hex');
  assert.equal(d.owner, want);
});

test('control 4: batch-revoke statement is single-use (replay rejected)', async () => {
  regNow = T0;
  const s = fakeStore(); const r = registry();
  await r.applyRegistration({ owner: OWNER, deviceDid: DEVICE.did, approverDid: DERIVED.registration.did, kind: 'seed' });
  const { signStatement } = await import('../src/e2ee-statement.mjs');
  const stmt = signStatement(DERIVED.registration, { aud: BASE.CACAO_AUD, domain: BASE.CACAO_DOMAIN,
    op: 'batch-revoke', owner: OWNER, actorDid: DERIVED.registration.did, args: [],
    issuedAt: T0, expiresAt: T0 + 300_000, epoch: 0 });
  const body = { owner: OWNER, registrationDid: DERIVED.registration.did, statement: stmt.fields, signature: stmt.signature };
  assert.equal((await post('batch-revoke', body, s, r)).status, 200);
  assert.equal((await post('batch-revoke', body, s, r)).status, 401, 'replayed batch-revoke must be 401');
});

test('control 5a: batch revoke kills pre-batch terminals, exempts seed applied at-or-after request, freezes adds', async () => {
  regNow = T0;
  const r = registry();
  const oldDev = DEVICE.did;
  await r.applyRegistration({ owner: OWNER, deviceDid: oldDev, approverDid: DERIVED.registration.did, kind: 'seed' });
  regNow += 1000; // batch requested strictly after enrollment
  const b = await r.requestBatchRevoke({ owner: OWNER, registrationDid: DERIVED.registration.did });
  assert.equal(b.status, 'pending');
  // A seed registration applied AFTER the batch request is exempt.
  const fresh = keyFromSeed(newSeed()).did;
  const p = await r.applyRegistration({ owner: OWNER, deviceDid: fresh, approverDid: DERIVED.registration.did, kind: 'seed' });
  assert.equal(p.status, 'pending');
  // Existing-device additions are frozen while the batch is pending.
  await assert.rejects(() => r.applyRegistration({ owner: OWNER, deviceDid: keyFromSeed(newSeed()).did,
    approverDid: oldDev, kind: 'existing-device' }), /batch-revoke-pending/);
  regNow += RECOVERY_WAIT_MS;
  assert.equal(await r.ownerOfDevice(oldDev), null, 'terminal enrolled before the batch is revoked');
  assert.equal(await r.ownerOfDevice(fresh), OWNER, 'seed applied at-or-after the request survives');
});

test('control 5b/6: existing-device registration is admitted immediately (no wait)', async () => {
  regNow = T0;
  const r = registry();
  await r.applyRegistration({ owner: OWNER, deviceDid: DEVICE.did, approverDid: DERIVED.registration.did, kind: 'seed' });
  const d2 = keyFromSeed(newSeed()).did;
  assert.deepEqual(await r.applyRegistration({ owner: OWNER, deviceDid: d2, approverDid: DEVICE.did, kind: 'existing-device' }),
    { status: 'admitted', repeated: false });
});

test('control 7: cancel budget resets after a seed registration is admitted', async () => {
  regNow = T0;
  const r = registry();
  await r.applyRegistration({ owner: OWNER, deviceDid: DEVICE.did, approverDid: DERIVED.registration.did, kind: 'seed' });
  const d2 = keyFromSeed(newSeed()).did;
  const p1 = await r.applyRegistration({ owner: OWNER, deviceDid: d2, approverDid: DERIVED.registration.did, kind: 'seed' });
  await r.cancelPending({ owner: OWNER, actorDid: DEVICE.did, pendingId: p1.id });
  const p2 = await r.applyRegistration({ owner: OWNER, deviceDid: d2, approverDid: DERIVED.registration.did, kind: 'seed' });
  regNow += RECOVERY_WAIT_MS; // p2 admitted (seed wins)
  assert.equal(await r.ownerOfDevice(d2), OWNER);
  const d3 = keyFromSeed(newSeed()).did;
  const p3 = await r.applyRegistration({ owner: OWNER, deviceDid: d3, approverDid: DERIVED.registration.did, kind: 'seed' });
  assert.deepEqual(await r.cancelPending({ owner: OWNER, actorDid: DEVICE.did, pendingId: p3.id }),
    { status: 'cancelled', id: p3.id }, 'budget restored after establishment');
});

test('control 8: caps bind, and reads create no owner record', async () => {
  regNow = T0;
  const r = registry();
  await r.applyRegistration({ owner: OWNER, deviceDid: DEVICE.did, approverDid: DERIVED.registration.did, kind: 'seed' });
  const pendings = [];
  for (let i = 0; i < 3; i++) {
    pendings.push(await r.applyRegistration({ owner: OWNER, deviceDid: keyFromSeed(newSeed()).did,
      approverDid: DERIVED.registration.did, kind: 'seed' }));
  }
  assert.ok(pendings.every((p) => p.status === 'pending'));
  await assert.rejects(() => r.applyRegistration({ owner: OWNER, deviceDid: keyFromSeed(newSeed()).did,
    approverDid: DERIVED.registration.did, kind: 'seed' }), /too-many-pending/);
  const before = r.owners.size;
  await r.packStatus({ owner: 'f'.repeat(64), sha256: 'e'.repeat(64) });
  assert.equal(r.owners.size, before, 'read must not create an owner record');
});

test('control 9: one device maps to one owner (index enforced)', async () => {
  regNow = T0;
  const r = registry();
  await r.applyRegistration({ owner: OWNER, deviceDid: DEVICE.did, approverDid: DERIVED.registration.did, kind: 'seed' });
  await assert.rejects(() => r.applyRegistration({ owner: 'b'.repeat(64), deviceDid: DEVICE.did,
    approverDid: DERIVED.registration.did, kind: 'seed' }), /device-registered-elsewhere/);
});

test('control 10: head name binds to owner; status reveals epoch only', async () => {
  regNow = T0;
  const s = fakeStore(); const r = registry();
  await r.applyRegistration({ owner: OWNER, deviceDid: DEVICE.did, approverDid: DERIVED.registration.did, kind: 'seed' });
  await r.publishHead({ owner: OWNER, deviceDid: DEVICE.did, seq: 1, headSha: '1'.repeat(64), headNameHex: DERIVED.headNameHex });
  await assert.rejects(() => r.publishHead({ owner: OWNER, deviceDid: DEVICE.did, seq: 2, headSha: '2'.repeat(64),
    headNameHex: '9'.repeat(64) }), /head-name-mismatch/);
  const st = await handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-registry/status/${OWNER}`), envFor(), deps(s, r));
  assert.equal(st.status, 200);
  assert.deepEqual(await st.json(), { epoch: 0 });
  const stUnknown = await handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-registry/status/${'f'.repeat(64)}`), envFor(), deps(s, r));
  assert.deepEqual(await stUnknown.json(), { epoch: 0 });
});

test('control 12/13: non-allowlisted owner denied; rate limit fires before signature check', async () => {
  regNow = T0;
  const s = fakeStore(); const r = registry();
  const denied = await post('revoke', { owner: OWNER, actorDid: DEVICE.did, targetDid: DEVICE.did }, s, r, envFor('b'.repeat(64)));
  assert.equal(denied.status, 403);
  const limited = { async limit() { return { success: false }; } };
  const env = { ...envFor(), WRITE_REQUEST_LIMITER: limited, WRITE_MIB_LIMITER: limited };
  const rl = await post('revoke', { owner: OWNER, actorDid: DEVICE.did, targetDid: DEVICE.did }, s, r, env);
  assert.equal(rl.status, 429, 'IP rate limit must fire before signature verification');
});

test('control 15: release of the last terminal waits, then the device can migrate seeds', async () => {
  regNow = T0;
  const r = registry();
  await r.applyRegistration({ owner: OWNER, deviceDid: DEVICE.did, approverDid: DERIVED.registration.did, kind: 'seed' });
  assert.equal(typeof r.releaseDevice, 'function');
  const out = await r.releaseDevice({ owner: OWNER, deviceDid: DEVICE.did, registrationDid: DERIVED.registration.did });
  assert.equal(out.status, 'pending', 'release to zero terminals waits');
  regNow += RECOVERY_WAIT_MS;
  assert.equal(await r.ownerOfDevice(DEVICE.did), null);
  // After release the device can register under a new seed owner.
  const other = deriveFromSeed(Buffer.alloc(32, 4));
  assert.deepEqual(await r.applyRegistration({ owner: other.owner, deviceDid: DEVICE.did,
    approverDid: other.registration.did, kind: 'seed' }), { status: 'admitted', repeated: false });
});
