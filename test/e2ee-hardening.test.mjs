// Reproduction attacks for the current head: each test runs the attack and
// expects the fixed behavior. Every test fails on f4651ae and passes after
// the fix. Fake storage only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { handle } from '../worker/src/index.mjs';
import { MemoryRegistry, RECOVERY_WAIT_MS } from '../worker/src/e2ee-registry.mjs';
import { deriveFromSeed, ownerFromRegistrationPub } from '../src/recovery-derivation.mjs';
import { signStatement } from '../src/e2ee-statement.mjs';
import { keyFromSeed, newSeed, mintDirect, e2eePutResource } from '../src/cacao.mjs';
import { ENV, NOW, fakeStore } from './worker-fixtures.mjs';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const packBytes = () => fs.readFileSync(new URL('./fixtures/drive-v1.car', import.meta.url));
const T0 = NOW().getTime();
const WRITER = keyFromSeed(newSeed());
const EENV = { ...ENV, CACAO_NONCE_SECRET: 'test-nonce-secret-0123456789abcdef', CACAO_AUD: 'https://yataverse.com',
               CACAO_DOMAIN: 'yataverse.com', CACAO_WRITER_DIDS: WRITER.did };
const DERIVED = deriveFromSeed(Buffer.from(Array.from({ length: 32 }, (_, i) => i)));
const OWNER = DERIVED.owner;
const DEVICE = keyFromSeed(newSeed());
let regNow = T0;
const registry = () => new MemoryRegistry({ now: () => regNow });
const envFor = (owner = OWNER) => ({ ...EENV, E2EE_OWNER_ALLOWLIST: owner });
const deps = (s, r) => ({ fetchImpl: s.fetchImpl, now: NOW, e2eeRegistry: r });
const stmt = (key, op, owner, args, epoch = 0, extra = {}) => signStatement(key, {
  aud: EENV.CACAO_AUD, domain: EENV.CACAO_DOMAIN, op, owner, actorDid: key.did,
  args, issuedAt: regNow, expiresAt: regNow + 300_000, epoch, ...extra });

async function register(s, r, { owner = OWNER, device = DEVICE, approver = DERIVED.registration, kind = 'seed', env } = {}) {
  const args = [device.did, approver.did, kind];
  const a = stmt(approver, 'register', owner, args);
  const c = stmt(device, 'register', owner, args);
  const body = { owner, deviceDid: device.did, kind,
    approval: { approverDid: approver.did, statement: a.fields, signature: a.signature },
    deviceConsent: { statement: c.fields, signature: c.signature } };
  return handle(new Request('https://yataverse.com/awai-drive/v1/e2ee-registry/register',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    env ?? envFor(owner), deps(s, r));
}

test('attack 1: unrelated key cannot seed-register for someone else\'s owner', async () => {
  regNow = T0;
  const s = fakeStore(); const r = registry();
  const attacker = keyFromSeed(newSeed());
  // Attacker's key does not bind OWNER (owner is sha256(prefix || real reg pub)).
  assert.notEqual(ownerFromRegistrationPub(attacker.publicRaw), OWNER);
  const res = await register(s, r, { approver: attacker });
  assert.equal(res.status, 401, 'unbound registration key must be 401');
  assert.equal(await r.ownerOfDevice(DEVICE.did), null);
  assert.ok(!r.owners.get(OWNER)?.registrationDid, 'registrationDid must not be set on failure');
});

test('attack 2: stolen first (seed-registered) phone does not survive bulk revoke', async () => {
  regNow = T0;
  const r = registry();
  const stolen = DEVICE.did;
  await r.applyRegistration({ owner: OWNER, deviceDid: stolen, approverDid: DERIVED.registration.did, kind: 'seed' });
  regNow += 1000; // the batch is requested strictly after enrollment
  const b = await r.requestBatchRevoke({ owner: OWNER, registrationDid: DERIVED.registration.did });
  assert.equal(b.status, 'pending');
  regNow += RECOVERY_WAIT_MS;
  assert.equal(await r.ownerOfDevice(stolen), null, 'device enrolled before the batch must be revoked');
});

test('attack 3: releasing the last terminal waits and is cancellable', async () => {
  regNow = T0;
  const r = registry();
  await r.applyRegistration({ owner: OWNER, deviceDid: DEVICE.did, approverDid: DERIVED.registration.did, kind: 'seed' });
  const out = await r.releaseDevice({ owner: OWNER, deviceDid: DEVICE.did, registrationDid: DERIVED.registration.did });
  assert.equal(out.status, 'pending', 'release to zero terminals must wait');
  assert.equal(out.effectiveAt, regNow + RECOVERY_WAIT_MS);
  assert.equal(await r.ownerOfDevice(DEVICE.did), OWNER, 'device still registered during the wait');
});

test('attack 4a: revoked device cannot re-register as existing-device', async () => {
  regNow = T0;
  const r = registry();
  const d2 = keyFromSeed(newSeed()).did;
  await r.applyRegistration({ owner: OWNER, deviceDid: DEVICE.did, approverDid: DERIVED.registration.did, kind: 'seed' });
  await r.applyRegistration({ owner: OWNER, deviceDid: d2, approverDid: DEVICE.did, kind: 'existing-device' });
  await r.revokeDevice({ owner: OWNER, actorDid: DEVICE.did, targetDid: d2 });
  await assert.rejects(() => r.applyRegistration({ owner: OWNER, deviceDid: d2, approverDid: DEVICE.did, kind: 'existing-device' }),
    /device-revoked-seed-only/);
});

test('attack 4b: revoked device can re-register via seed as a new generation', async () => {
  regNow = T0;
  const r = registry();
  const d2 = keyFromSeed(newSeed()).did;
  await r.applyRegistration({ owner: OWNER, deviceDid: DEVICE.did, approverDid: DERIVED.registration.did, kind: 'seed' });
  await r.applyRegistration({ owner: OWNER, deviceDid: d2, approverDid: DEVICE.did, kind: 'existing-device' });
  await r.revokeDevice({ owner: OWNER, actorDid: DEVICE.did, targetDid: d2 });
  const re = await r.applyRegistration({ owner: OWNER, deviceDid: d2, approverDid: DERIVED.registration.did, kind: 'seed' });
  assert.equal(re.status, 'pending', 'seed re-registration goes through the wait while a device remains');
  regNow += RECOVERY_WAIT_MS;
  assert.equal(await r.ownerOfDevice(d2), OWNER, 'new generation is live after the wait');
});

test('attack 5a: statement window is bounded (over-long and future statements rejected)', async () => {
  regNow = T0;
  const s = fakeStore(); const r = registry();
  assert.equal((await register(s, r)).status, 200);
  const call = (fields, signature) => handle(new Request('https://yataverse.com/awai-drive/v1/e2ee-registry/revoke',
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, statement: fields, signature }) }), envFor(), deps(s, r));
  const long = stmt(DEVICE, 'revoke', OWNER, [DEVICE.did], 0, { expiresAt: regNow + 3_600_000 });
  assert.equal((await call(long.fields, long.signature)).status, 401, 'window over 300s must be 401');
  const future = stmt(DEVICE, 'revoke', OWNER, [DEVICE.did], 0, { issuedAt: regNow + 3_600_000, expiresAt: regNow + 3_900_000 });
  assert.equal((await call(future.fields, future.signature)).status, 401, 'future issuedAt must be 401');
});

test('attack 5b: consuming a statement for an unknown owner creates no record', async () => {
  regNow = T0;
  const r = registry();
  await assert.rejects(() => r.consumeStatement({ owner: 'f'.repeat(64), signature: 'A'.repeat(86),
    expiresAt: regNow, epoch: 0 }), /statement-expired|statement-stale-epoch/);
  assert.equal(r.owners.has('f'.repeat(64)), false, 'failed consume must not create an owner record');
});

test('attack 6: wrong args shape for a non-register op is rejected', async () => {
  regNow = T0;
  const s = fakeStore(); const r = registry();
  assert.equal((await register(s, r)).status, 200);
  const bad = stmt(DEVICE, 'revoke', OWNER, [DEVICE.did, 'extra']);
  const res = await handle(new Request('https://yataverse.com/awai-drive/v1/e2ee-registry/revoke',
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, statement: bad.fields, signature: bad.signature }) }), envFor(), deps(s, r));
  assert.equal(res.status, 400, 'revoke with 2 args must be 400');
});

test('attack 7: head publish derives owner from the index; no record for a bogus body owner', async () => {
  regNow = T0;
  const s = fakeStore(); const r = registry();
  assert.equal((await register(s, r)).status, 200);
  const bogus = 'e'.repeat(64);
  const n = (await (await handle(new Request('https://yataverse.com/auth/nonce'), EENV, deps(s, r))).json()).nonce;
  const auth = `CACAO ${mintDirect(DEVICE, { aud: 'https://yataverse.com', domain: 'yataverse.com', nonce: n,
    resources: [`yataverse:e2ee:head:${DERIVED.headNameHex}:1`], now: T0, ttlSec: 120 }).cacaoB64}`;
  const res = await handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-heads/${DERIVED.headNameHex}`,
    { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({ owner: bogus, deviceDid: DEVICE.did, seq: 1, headSha: '1'.repeat(64) }) }), envFor(), deps(s, r));
  assert.equal(res.status, 400, 'body owner must match the index-derived owner');
  assert.equal(r.owners.has(bogus), false, 'bogus owner record must not be created');
});

test('attack 8: PUT over the pack count cap stores no bytes', async () => {
  regNow = T0;
  const s = fakeStore(); const r = registry();
  assert.equal((await register(s, r)).status, 200);
  for (let i = 0; i < 1024; i++) {
    await r.recordPack({ owner: OWNER, deviceDid: DEVICE.did, sha256: sha(Buffer.from(`filler-${i}`)), size: 1 });
  }
  const bytes = packBytes(); const id = sha(bytes);
  const n = (await (await handle(new Request('https://yataverse.com/auth/nonce'), EENV, deps(s, r))).json()).nonce;
  const auth = `CACAO ${mintDirect(DEVICE, { aud: 'https://yataverse.com', domain: 'yataverse.com', nonce: n,
    resources: [e2eePutResource(id)], now: T0, ttlSec: 120 }).cacaoB64}`;
  const put = await handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-packs/${id}`,
    { method: 'PUT', body: bytes, headers: { authorization: auth, 'content-type': 'application/vnd.ipld.car' } }),
    envFor(), deps(s, r));
  assert.equal(put.status, 429, 'over-cap PUT must be 429');
  assert.equal(s.objects.has(`ipld/e2ee-packs/${id}`), false, 'over-cap bytes must not be stored');
});
