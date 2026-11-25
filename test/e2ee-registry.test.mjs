// Owner registry unit tests (design §0, §3–§5): fake storage, fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRegistry, RECOVERY_WAIT_MS } from '../worker/src/e2ee-registry.mjs';
import { keyFromSeed, newSeed } from '../src/cacao.mjs';

const OWNER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const SHA = 'c'.repeat(64);
const dev = () => keyFromSeed(newSeed()).did;
let now = 1_000_000;
const reg = () => new MemoryRegistry({ now: () => now });

test('first seed registration is admitted at once; later devices wait while a device remains', async () => {
  now = 1_000_000;
  const r = reg();
  const d1 = dev(); const d2 = dev(); const regDid = dev();
  assert.deepEqual(await r.applyRegistration({ owner: OWNER, deviceDid: d1, approverDid: regDid, kind: 'seed' }),
    { status: 'admitted', repeated: false });
  const pending = await r.applyRegistration({ owner: OWNER, deviceDid: d2, approverDid: d1, kind: 'existing-device' });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.admitAt, now + RECOVERY_WAIT_MS);
  assert.equal(await r.ownerOfDevice(d2), null, 'pending device cannot fetch yet');
  now += RECOVERY_WAIT_MS;
  assert.equal(await r.ownerOfDevice(d2), OWNER, 'wait always ends; device admitted on schedule');
});

test('cancel once: second application is not cancellable; seed ultimately wins', async () => {
  now = 1_000_000;
  const r = reg();
  const d1 = dev(); const regDid = dev();
  await r.applyRegistration({ owner: OWNER, deviceDid: d1, approverDid: regDid, kind: 'seed' });
  const d2 = dev();
  const p1 = await r.applyRegistration({ owner: OWNER, deviceDid: d2, approverDid: regDid, kind: 'seed' });
  assert.equal(p1.status, 'pending');
  await assert.rejects(() => r.cancelPending({ owner: OWNER, actorDid: dev(), pendingId: p1.id }), /actor-not-registered/);
  assert.deepEqual(await r.cancelPending({ owner: OWNER, actorDid: d1, pendingId: p1.id }), { status: 'cancelled', id: p1.id });
  // Seed wins: a fresh seed-signed application after the cancel still succeeds.
  const p2 = await r.applyRegistration({ owner: OWNER, deviceDid: d2, approverDid: regDid, kind: 'seed' });
  assert.equal(p2.status, 'pending');
  // Second application is not cancellable.
  await assert.rejects(() => r.cancelPending({ owner: OWNER, actorDid: d1, pendingId: p2.id }), /pending-not-cancellable/);
  now += RECOVERY_WAIT_MS;
  assert.equal(await r.ownerOfDevice(d2), OWNER);
});

test('single revoke is immediate; revoked device cannot fetch; batch revoke waits', async () => {
  now = 1_000_000;
  const r = reg();
  const d1 = dev(); const d2 = dev(); const regDid = dev();
  await r.applyRegistration({ owner: OWNER, deviceDid: d1, approverDid: regDid, kind: 'seed' });
  await r.applyRegistration({ owner: OWNER, deviceDid: d2, approverDid: d1, kind: 'existing-device' });
  now += RECOVERY_WAIT_MS;
  await r.recordPack({ owner: OWNER, deviceDid: d1, sha256: SHA, size: 10 });
  assert.ok(await r.canFetch({ deviceDid: d1, sha256: SHA }));
  assert.ok(await r.canFetch({ deviceDid: d2, sha256: SHA }));
  // Batch revoke: pending with the same wait; fetch still works until effective.
  const b = await r.requestBatchRevoke({ owner: OWNER, registrationDid: regDid });
  assert.equal(b.status, 'pending');
  assert.equal(b.effectiveAt, now + RECOVERY_WAIT_MS);
  assert.ok(await r.canFetch({ deviceDid: d1, sha256: SHA }), 'batch revoke not yet effective');
  now += RECOVERY_WAIT_MS;
  assert.equal(await r.canFetch({ deviceDid: d1, sha256: SHA }), null, 'epoch advanced: devices revoked');
  const status = await r.packStatus({ owner: OWNER, sha256: SHA });
  assert.equal(status.epoch, 1);
  // Registration key itself survives the batch revoke (seed, not device).
  const d3 = dev();
  const re = await r.applyRegistration({ owner: OWNER, deviceDid: d3, approverDid: regDid, kind: 'seed' });
  assert.equal(re.status, 'admitted', 'no live devices remain, so no wait');
  // Single revoke is immediate.
  await r.revokeDevice({ owner: OWNER, actorDid: d3, targetDid: d3 });
  assert.equal(await r.ownerOfDevice(d3), null);
});

test('registration key mismatch: another seed cannot register for this owner', async () => {
  now = 1_000_000;
  const r = reg();
  const d1 = dev();
  await r.applyRegistration({ owner: OWNER, deviceDid: d1, approverDid: dev(), kind: 'seed' });
  await assert.rejects(() => r.applyRegistration({ owner: OWNER, deviceDid: dev(), approverDid: dev(), kind: 'seed' }),
    /registration-key-mismatch/);
  await assert.rejects(() => r.applyRegistration({ owner: OTHER, deviceDid: dev(), approverDid: dev(), kind: 'existing-device' }),
    /approver-not-registered/);
});

test('head ordering: next sequence only, stale rejected, same-hash retry ok', async () => {
  now = 1_000_000;
  const r = reg();
  const d1 = dev(); const regDid = dev();
  await r.applyRegistration({ owner: OWNER, deviceDid: d1, approverDid: regDid, kind: 'seed' });
  const h1 = '1'.repeat(64); const h2 = '2'.repeat(64);
  assert.deepEqual(await r.publishHead({ owner: OWNER, deviceDid: d1, seq: 1, headSha: h1 }), { status: 'published', seq: 1 });
  assert.deepEqual(await r.publishHead({ owner: OWNER, deviceDid: d1, seq: 1, headSha: h1 }), { status: 'repeated', seq: 1 });
  await assert.rejects(() => r.publishHead({ owner: OWNER, deviceDid: d1, seq: 1, headSha: h2 }), /head-seq-conflict/);
  await assert.rejects(() => r.publishHead({ owner: OWNER, deviceDid: d1, seq: 3, headSha: h2 }), /head-seq-not-allocated/);
  assert.deepEqual(await r.publishHead({ owner: OWNER, deviceDid: d1, seq: 2, headSha: h2 }), { status: 'published', seq: 2 });
  await assert.rejects(() => r.publishHead({ owner: OWNER, deviceDid: d1, seq: 1, headSha: h1 }), /head-seq-rollback/);
});

test('pack record requires a live device; fetch is per (device, owner, sha)', async () => {
  now = 1_000_000;
  const r = reg();
  const d1 = dev(); const regDid = dev();
  await assert.rejects(() => r.recordPack({ owner: OWNER, deviceDid: d1, sha256: SHA, size: 5 }), /device-not-registered/);
  await r.applyRegistration({ owner: OWNER, deviceDid: d1, approverDid: regDid, kind: 'seed' });
  await r.recordPack({ owner: OWNER, deviceDid: d1, sha256: SHA, size: 5 });
  assert.deepEqual(await r.recordPack({ owner: OWNER, deviceDid: d1, sha256: SHA, size: 5 }), { status: 'repeated' });
  await assert.rejects(() => r.recordPack({ owner: OWNER, deviceDid: d1, sha256: SHA, size: 6 }), /pack-size-mismatch/);
  assert.equal(await r.canFetch({ deviceDid: dev(), sha256: SHA }), null);
  assert.equal(await r.canFetch({ deviceDid: d1, sha256: 'd'.repeat(64) }), null);
});
