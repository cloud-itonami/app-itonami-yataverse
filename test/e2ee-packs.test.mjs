// Owner-scoped E2EE pack fetch (design §1, §6–§8): fake B2 + in-memory registry.
// Every negative case must store nothing / record nothing, or answer 404/401
// uniformly. No live bucket, no Durable Object, no keys created by the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { handle } from '../worker/src/index.mjs';
import { MemoryRegistry, RECOVERY_WAIT_MS } from '../worker/src/e2ee-registry.mjs';
import { registrationMessage } from '../worker/src/e2ee-packs.mjs';
import { deriveFromSeed } from '../src/recovery-derivation.mjs';
import { keyFromSeed, newSeed, mintDirect, e2eeGetResource, e2eePutResource, e2eeHeadResource } from '../src/cacao.mjs';
import { ENV, NOW, fakeStore, dataKeys } from './worker-fixtures.mjs';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const packBytes = () => fs.readFileSync(new URL('./fixtures/drive-v1.car', import.meta.url));
const T0 = NOW().getTime();
const WRITER = keyFromSeed(newSeed()); // only for nonce issuance; devices are NOT writers
const EENV = { ...ENV, CACAO_NONCE_SECRET: 'test-nonce-secret-0123456789abcdef', CACAO_AUD: 'https://yataverse.com',
               CACAO_DOMAIN: 'yataverse.com', CACAO_WRITER_DIDS: WRITER.did };
const SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const DERIVED = deriveFromSeed(SEED); // owner pseudonym + registration key from the agreed table
const OWNER = DERIVED.owner;
const DEVICE = keyFromSeed(newSeed());
const STRANGER = keyFromSeed(newSeed());

let regNow = T0;
const registry = () => new MemoryRegistry({ now: () => regNow });
const deps = (s, r) => ({ fetchImpl: s.fetchImpl, now: NOW, e2eeRegistry: r });
const packUrl = (id) => `https://yataverse.com/awai-drive/v1/e2ee-packs/${id}`;
const CAR = 'application/vnd.ipld.car';

async function nonce(s) {
  const r = await handle(new Request('https://yataverse.com/auth/nonce'), EENV, deps(s, registry()));
  assert.equal(r.status, 200);
  return (await r.json()).nonce;
}
const cacao = (key, n, resources, extra = {}) =>
  `CACAO ${mintDirect(key, { aud: 'https://yataverse.com', domain: 'yataverse.com', nonce: n, resources, now: T0, ttlSec: 120, ...extra }).cacaoB64}`;
const sign = (key, msg) => crypto.sign(null, Buffer.from(msg, 'utf8'), key.privateKey).toString('base64url');

async function register(s, r, { owner = OWNER, device = DEVICE, approver = DERIVED.registration, kind = 'seed' } = {}) {
  const body = { owner, deviceDid: device.did, approval: { kind, approverDid: approver.did,
    signature: sign(approver, registrationMessage(owner, device.did, approver.did)) } };
  const res = await handle(new Request('https://yataverse.com/awai-drive/v1/e2ee-registry/register',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), EENV, deps(s, r));
  return res;
}

async function setup() {
  regNow = T0;
  const s = fakeStore(); const r = registry();
  assert.equal((await register(s, r)).status, 200);
  return { s, r };
}

const putReq = (bytes, id, auth) => new Request(packUrl(id), { method: 'PUT', body: bytes,
  headers: { authorization: auth, 'content-type': CAR } });
const getReq = (id, auth) => new Request(packUrl(id), { headers: { authorization: auth } });

test('register (seed) -> PUT binds bytes -> GET serves them; legacy route cannot', async () => {
  const { s, r } = await setup();
  const bytes = packBytes(); const id = sha(bytes); const n = await nonce(s);
  const put = await handle(putReq(bytes, id, cacao(DEVICE, n, [e2eePutResource(id)])), EENV, deps(s, r));
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { sha256: id, bytes: bytes.length });
  assert.ok(s.objects.has(`ipld/e2ee-packs/${id}`));
  assert.ok(!s.objects.has(`ipld/drive-packs/${id}`));
  const get = await handle(getReq(id, cacao(DEVICE, n, [e2eeGetResource(id)])), EENV, deps(s, r));
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('cache-control'), 'private, no-store');
  assert.equal(sha(Buffer.from(await get.arrayBuffer())), id);
  // Legacy unauthenticated route and the block route cannot read these bytes.
  const legacy = await handle(new Request(`https://yataverse.com/awai-drive/v1/packs/${id}`), EENV, deps(s, r));
  assert.equal(legacy.status, 404);
});

test('negative matrix: 401 for bad CACAO, uniform 404 for not-yours / missing / revoked', async () => {
  const { s, r } = await setup();
  const bytes = packBytes(); const id = sha(bytes); const n = await nonce(s);
  assert.equal((await handle(putReq(bytes, id, cacao(DEVICE, n, [e2eePutResource(id)])), EENV, deps(s, r))).status, 200);
  const otherId = sha(Buffer.from('another pack'));
  const cases = [
    ['missing credential', new Request(packUrl(id)), 401],
    ['valid CACAO, unregistered device', getReq(id, cacao(STRANGER, n, [e2eeGetResource(id)])), 404],
    ['other pack id signature reused', getReq(id, cacao(DEVICE, n, [e2eeGetResource(otherId)])), 404],
    ['missing pack', getReq(otherId, cacao(DEVICE, n, [e2eeGetResource(otherId)])), 404],
  ];
  for (const [name, req, want] of cases) {
    const res = await handle(req, EENV, deps(s, r));
    assert.equal(res.status, want, name);
    if (want === 404) assert.deepEqual(await res.json(), { error: 'pack-not-found' }, name);
  }
  // Expired CACAO -> 401.
  const expired = cacao(DEVICE, n, [e2eeGetResource(id)], { ttlSec: 60 });
  const late = await handle(getReq(id, expired), EENV, { ...deps(s, r), now: () => new Date(T0 + 61_000) });
  assert.equal(late.status, 401); assert.equal((await late.json()).error, 'cacao-expired');
  // Another person's credential -> 404.
  const other = keyFromSeed(newSeed());
  const r2 = registry(); const s2 = fakeStore();
  const derived2 = deriveFromSeed(Buffer.alloc(32, 9));
  assert.equal((await register(s2, r2, { owner: derived2.owner, device: other, approver: derived2.registration })).status, 200);
  assert.equal((await handle(getReq(id, cacao(other, await nonce(s2), [e2eeGetResource(id)])), EENV, deps(s2, r2))).status, 404);
});

test('bytes bind before record: truncated body 400, readback mismatch 502, record without bytes 404', async () => {
  const { s, r } = await setup();
  const bytes = packBytes(); const id = sha(bytes); const n = await nonce(s);
  const truncated = bytes.subarray(0, bytes.length - 10);
  const t = await handle(putReq(truncated, id, cacao(DEVICE, n, [e2eePutResource(id)])), EENV, deps(s, r));
  assert.equal(t.status, 400); assert.equal((await t.json()).error, 'pack-does-not-hash-to-id');
  assert.equal(await r.canFetch({ deviceDid: DEVICE.did, sha256: id }), null, 'truncated PUT created no record');
  assert.equal(dataKeys(s).length, 0);
  // Readback mismatch: store returns tampered bytes.
  const bad = fakeStore({ mode: 'corrupt-store' });
  const m = await handle(putReq(bytes, id, cacao(DEVICE, n, [e2eePutResource(id)])), EENV, deps(bad, r));
  assert.equal(m.status, 502); assert.equal((await m.json()).error, 'readback-mismatch');
  assert.equal(await r.canFetch({ deviceDid: DEVICE.did, sha256: id }), null, 'readback mismatch created no record');
  // Record without bytes (interrupted PUT): inserted directly, store empty -> 404.
  await r.recordPack({ owner: OWNER, deviceDid: DEVICE.did, sha256: id, size: bytes.length });
  const g = await handle(getReq(id, cacao(DEVICE, n, [e2eeGetResource(id)])), EENV, deps(s, r));
  assert.equal(g.status, 404);
});

test('sha256-only: GET for a pack whose bytes were never submitted -> 404', async () => {
  const { s, r } = await setup();
  const id = sha(packBytes()); const n = await nonce(s);
  const g = await handle(getReq(id, cacao(DEVICE, n, [e2eeGetResource(id)])), EENV, deps(s, r));
  assert.equal(g.status, 404); assert.deepEqual(await g.json(), { error: 'pack-not-found' });
});

test('forged registry record: pack record moved to another owner -> 404', async () => {
  const { s, r } = await setup();
  const bytes = packBytes(); const id = sha(bytes); const n = await nonce(s);
  assert.equal((await handle(putReq(bytes, id, cacao(DEVICE, n, [e2eePutResource(id)])), EENV, deps(s, r))).status, 200);
  const rec = r.owners.get(OWNER); const pack = rec.packs.get(id);
  rec.packs.delete(id); // tamper: record no longer names this (owner, sha)
  const g = await handle(getReq(id, cacao(DEVICE, n, [e2eeGetResource(id)])), EENV, deps(s, r));
  assert.equal(g.status, 404);
  rec.packs.set(id, pack);
  assert.equal((await handle(getReq(id, cacao(DEVICE, n, [e2eeGetResource(id)])), EENV, deps(s, r))).status, 200);
});

test('revoked terminal GET -> 404; second device survives', async () => {
  const { s, r } = await setup();
  const bytes = packBytes(); const id = sha(bytes); const n = await nonce(s);
  assert.equal((await handle(putReq(bytes, id, cacao(DEVICE, n, [e2eePutResource(id)])), EENV, deps(s, r))).status, 200);
  const d2 = keyFromSeed(newSeed());
  const reg2 = await register(s, r, { device: d2, approver: DEVICE, kind: 'existing-device' });
  assert.equal((await reg2.json()).status, 'pending', 'second terminal waits while one remains');
  regNow += RECOVERY_WAIT_MS;
  assert.equal((await handle(getReq(id, cacao(d2, n, [e2eeGetResource(id)])), EENV, deps(s, r))).status, 200);
  const revoke = await handle(new Request('https://yataverse.com/awai-drive/v1/e2ee-registry/revoke',
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, actorDid: d2.did, targetDid: DEVICE.did }) }), EENV, deps(s, r));
  assert.equal(revoke.status, 200);
  assert.equal((await handle(getReq(id, cacao(DEVICE, n, [e2eeGetResource(id)])), EENV, deps(s, r))).status, 404);
  assert.equal((await handle(getReq(id, cacao(d2, n, [e2eeGetResource(id)])), EENV, deps(s, r))).status, 200);
});

test('registration endpoint: bad approval signature -> 401; no registry -> 503', async () => {
  const s = fakeStore(); const r = registry();
  const bad = await handle(new Request('https://yataverse.com/awai-drive/v1/e2ee-registry/register',
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, deviceDid: DEVICE.did,
        approval: { kind: 'seed', approverDid: DERIVED.registration.did, signature: 'A'.repeat(86) } }) }), EENV, deps(s, r));
  assert.equal(bad.status, 401);
  const bytes = packBytes(); const id = sha(bytes);
  const noReg = await handle(getReq(id, 'CACAO x'), EENV, { fetchImpl: s.fetchImpl, now: NOW });
  assert.equal(noReg.status, 503); assert.equal((await noReg.json()).error, 'e2ee-registry-not-configured');
});

test('head publish: registry ordering, stale sequence -> 409', async () => {
  const { s, r } = await setup();
  const headName = DERIVED.headNameHex; const n = await nonce(s);
  const pub = (seq, headSha) => handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-heads/${headName}`,
    { method: 'POST', headers: { 'content-type': 'application/json', authorization: cacao(DEVICE, n, [e2eeHeadResource(headName, seq)]) },
      body: JSON.stringify({ owner: OWNER, deviceDid: DEVICE.did, seq, headSha }) }), EENV, deps(s, r));
  assert.equal((await pub(1, '1'.repeat(64))).status, 200);
  assert.equal((await pub(1, '1'.repeat(64))).status, 200, 'idempotent retry');
  const stale = await pub(1, '2'.repeat(64));
  assert.equal(stale.status, 409);
  assert.equal((await pub(2, '2'.repeat(64))).status, 200);
});
