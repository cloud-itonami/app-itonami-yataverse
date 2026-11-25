// Owner-scoped E2EE pack fetch (design §1, §6–§8): fake B2 + in-memory registry.
// Every negative case must store nothing / record nothing, or answer 404/401
// uniformly. No live bucket, no Durable Object, no keys created by the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { handle } from '../worker/src/index.mjs';
import { MemoryRegistry, RECOVERY_WAIT_MS } from '../worker/src/e2ee-registry.mjs';
import { deriveFromSeed } from '../src/recovery-derivation.mjs';
import { signStatement } from '../src/e2ee-statement.mjs';
import { keyFromSeed, newSeed, mintDirect, e2eeGetResource, e2eePutResource, e2eeHeadResource, e2eeHeadReadResource } from '../src/cacao.mjs';
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
const envFor = (owner = OWNER) => ({ ...EENV, E2EE_OWNER_ALLOWLIST: owner });
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

/** A signed statement for one op (fix design §1). */
const stmt = (key, op, owner, args, epoch = 0) => signStatement(key, {
  aud: EENV.CACAO_AUD, domain: EENV.CACAO_DOMAIN, op, owner, actorDid: key.did,
  args, issuedAt: regNow, expiresAt: regNow + 300_000, epoch });

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

async function setup() {
  regNow = T0;
  const s = fakeStore(); const r = registry();
  assert.equal((await register(s, r)).status, 200);
  return { s, r };
}

const putReq = (bytes, id, authorization) => new Request(packUrl(id), { method: 'PUT', body: bytes,
  headers: { authorization, 'content-type': CAR } });
const getReq = (id, authorization) => new Request(packUrl(id), { headers: { authorization } });

test('register (seed) -> PUT binds bytes -> GET serves them; legacy route cannot', async () => {
  const { s, r } = await setup();
  const bytes = packBytes(); const id = sha(bytes); const n = await nonce(s);
  const put = await handle(putReq(bytes, id, cacao(DEVICE, n, [e2eePutResource(id)])), envFor(), deps(s, r));
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { sha256: id, bytes: bytes.length });
  assert.ok(s.objects.has(`ipld/e2ee-packs/${id}`));
  assert.ok(!s.objects.has(`ipld/drive-packs/${id}`));
  const get = await handle(getReq(id, cacao(DEVICE, n, [e2eeGetResource(id)])), envFor(), deps(s, r));
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('cache-control'), 'private, no-store');
  assert.equal(sha(Buffer.from(await get.arrayBuffer())), id);
  // Legacy unauthenticated route and the block route cannot read these bytes.
  const legacy = await handle(new Request(`https://yataverse.com/awai-drive/v1/packs/${id}`), envFor(), deps(s, r));
  assert.equal(legacy.status, 404);
});

test('negative matrix: 401 for bad CACAO, uniform 404 for not-yours / missing / revoked', async () => {
  const { s, r } = await setup();
  const bytes = packBytes(); const id = sha(bytes); const n = await nonce(s);
  assert.equal((await handle(putReq(bytes, id, cacao(DEVICE, n, [e2eePutResource(id)])), envFor(), deps(s, r))).status, 200);
  const otherId = sha(Buffer.from('another pack'));
  const cases = [
    ['missing credential', new Request(packUrl(id)), 401],
    ['valid CACAO, unregistered device', getReq(id, cacao(STRANGER, n, [e2eeGetResource(id)])), 404],
    ['other pack id signature reused', getReq(id, cacao(DEVICE, n, [e2eeGetResource(otherId)])), 404],
    ['missing pack', getReq(otherId, cacao(DEVICE, n, [e2eeGetResource(otherId)])), 404],
  ];
  for (const [name, req, want] of cases) {
    const res = await handle(req, envFor(), deps(s, r));
    assert.equal(res.status, want, name);
    if (want === 404) assert.deepEqual(await res.json(), { error: 'pack-not-found' }, name);
  }
  // Expired CACAO -> 401.
  const expired = cacao(DEVICE, n, [e2eeGetResource(id)], { ttlSec: 60 });
  const late = await handle(getReq(id, expired), envFor(), { ...deps(s, r), now: () => new Date(T0 + 61_000) });
  assert.equal(late.status, 401); assert.equal((await late.json()).error, 'cacao-expired');
  // Another person's credential -> 404.
  const other = keyFromSeed(newSeed());
  const r2 = registry(); const s2 = fakeStore();
  const derived2 = deriveFromSeed(Buffer.alloc(32, 9));
  assert.equal((await register(s2, r2, { owner: derived2.owner, device: other, approver: derived2.registration })).status, 200);
  assert.equal((await handle(getReq(id, cacao(other, await nonce(s2), [e2eeGetResource(id)])), envFor(derived2.owner), deps(s2, r2))).status, 404);
});

test('bytes bind before record: truncated body 400, readback mismatch 502, record without bytes 404', async () => {
  const { s, r } = await setup();
  const bytes = packBytes(); const id = sha(bytes); const n = await nonce(s);
  const truncated = bytes.subarray(0, bytes.length - 10);
  const t = await handle(putReq(truncated, id, cacao(DEVICE, n, [e2eePutResource(id)])), envFor(), deps(s, r));
  assert.equal(t.status, 400); assert.equal((await t.json()).error, 'pack-does-not-hash-to-id');
  assert.equal(await r.canFetch({ deviceDid: DEVICE.did, sha256: id }), null, 'truncated PUT created no record');
  assert.equal(dataKeys(s).length, 0);
  // Readback mismatch: store returns tampered bytes.
  const bad = fakeStore({ mode: 'corrupt-store' });
  const m = await handle(putReq(bytes, id, cacao(DEVICE, n, [e2eePutResource(id)])), envFor(), deps(bad, r));
  assert.equal(m.status, 502); assert.equal((await m.json()).error, 'readback-mismatch');
  assert.equal(await r.canFetch({ deviceDid: DEVICE.did, sha256: id }), null, 'readback mismatch created no record');
  // Record without bytes (interrupted PUT): inserted directly, store empty -> 404.
  await r.recordPack({ owner: OWNER, deviceDid: DEVICE.did, sha256: id, size: bytes.length });
  const g = await handle(getReq(id, cacao(DEVICE, n, [e2eeGetResource(id)])), envFor(), deps(s, r));
  assert.equal(g.status, 404);
});

test('sha256-only: GET for a pack whose bytes were never submitted -> 404', async () => {
  const { s, r } = await setup();
  const id = sha(packBytes()); const n = await nonce(s);
  const g = await handle(getReq(id, cacao(DEVICE, n, [e2eeGetResource(id)])), envFor(), deps(s, r));
  assert.equal(g.status, 404); assert.deepEqual(await g.json(), { error: 'pack-not-found' });
});

test('forged registry record: pack record moved to another owner -> 404', async () => {
  const { s, r } = await setup();
  const bytes = packBytes(); const id = sha(bytes); const n = await nonce(s);
  assert.equal((await handle(putReq(bytes, id, cacao(DEVICE, n, [e2eePutResource(id)])), envFor(), deps(s, r))).status, 200);
  const rec = r.owners.get(OWNER); const pack = rec.packs.get(id);
  rec.packs.delete(id); // tamper: record no longer names this (owner, sha)
  const g = await handle(getReq(id, cacao(DEVICE, n, [e2eeGetResource(id)])), envFor(), deps(s, r));
  assert.equal(g.status, 404);
  rec.packs.set(id, pack);
  assert.equal((await handle(getReq(id, cacao(DEVICE, n, [e2eeGetResource(id)])), envFor(), deps(s, r))).status, 200);
});

test('revoked terminal GET -> 404; second device survives (signed revoke)', async () => {
  const { s, r } = await setup();
  const bytes = packBytes(); const id = sha(bytes); const n = await nonce(s);
  assert.equal((await handle(putReq(bytes, id, cacao(DEVICE, n, [e2eePutResource(id)])), envFor(), deps(s, r))).status, 200);
  const d2 = keyFromSeed(newSeed());
  const reg2 = await register(s, r, { device: d2, approver: DEVICE, kind: 'existing-device' });
  assert.equal((await reg2.json()).status, 'admitted', 'existing-device addition is immediate');
  const rv = stmt(d2, 'revoke', OWNER, [DEVICE.did]);
  const revoke = await handle(new Request('https://yataverse.com/awai-drive/v1/e2ee-registry/revoke',
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, statement: rv.fields, signature: rv.signature }) }), envFor(), deps(s, r));
  assert.equal(revoke.status, 200);
  assert.equal((await handle(getReq(id, cacao(DEVICE, n, [e2eeGetResource(id)])), envFor(), deps(s, r))).status, 404);
  assert.equal((await handle(getReq(id, cacao(d2, n, [e2eeGetResource(id)])), envFor(), deps(s, r))).status, 200);
});

test('registration endpoint: missing consent -> 401; non-allowlisted owner -> 403; no registry -> 503', async () => {
  const s = fakeStore(); const r = registry();
  const bad = await handle(new Request('https://yataverse.com/awai-drive/v1/e2ee-registry/register',
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, deviceDid: DEVICE.did, kind: 'seed',
        approval: { approverDid: DERIVED.registration.did, statement: {}, signature: 'A'.repeat(86) } }) }), envFor(), deps(s, r));
  assert.equal(bad.status, 401);
  const denied = await register(s, r, { env: envFor('b'.repeat(64)) });
  assert.equal(denied.status, 403); assert.equal((await denied.json()).error, 'owner-not-allowlisted');
  const bytes = packBytes(); const id = sha(bytes);
  const noReg = await handle(getReq(id, 'CACAO x'), envFor(), { fetchImpl: s.fetchImpl, now: NOW });
  assert.equal(noReg.status, 503); assert.equal((await noReg.json()).error, 'e2ee-registry-not-configured');
});

test('statement replay and expiry are rejected', async () => {
  const { s, r } = await setup();
  const rv = stmt(DEVICE, 'revoke', OWNER, [DEVICE.did]);
  const body = JSON.stringify({ owner: OWNER, statement: rv.fields, signature: rv.signature });
  const call = () => handle(new Request('https://yataverse.com/awai-drive/v1/e2ee-registry/revoke',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body }), envFor(), deps(s, r));
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 401, 'replayed statement must be rejected');
  // Expired statement (window in the past relative to the registry clock).
  const old = signStatement(DEVICE, { aud: EENV.CACAO_AUD, domain: EENV.CACAO_DOMAIN, op: 'revoke',
    owner: OWNER, actorDid: DEVICE.did, args: [DEVICE.did], issuedAt: T0 - 600_000, expiresAt: T0 - 300_000, epoch: 0 });
  const exp = await handle(new Request('https://yataverse.com/awai-drive/v1/e2ee-registry/revoke',
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, statement: old.fields, signature: old.signature }) }), envFor(), deps(s, r));
  assert.equal(exp.status, 401); assert.equal((await exp.json()).error, 'statement-expired');
});

test('status endpoint reveals epoch + incarnation; unknown owner gets the same shape', async () => {
  const { s, r } = await setup();
  const st = await handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-registry/status/${OWNER}`), envFor(), deps(s, r));
  assert.equal(st.status, 200); assert.deepEqual(await st.json(), { epoch: 0, incarnation: 0 });
  const un = await handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-registry/status/${'f'.repeat(64)}`), envFor(), deps(s, r));
  assert.deepEqual(await un.json(), { epoch: 0, incarnation: 0 });
  // Allowlist first: a non-allowlisted owner never touches the registry.
  let calls = 0;
  const spy = { epochOf: async () => { calls++; return 7; } };
  const hidden = await handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-registry/status/${'e'.repeat(64)}`),
    envFor(`${OWNER}:2`), deps(s, spy));
  assert.equal(hidden.status, 200);
  assert.deepEqual(await hidden.json(), { epoch: 0, incarnation: 0 });
  assert.equal(calls, 0, 'non-allowlisted status must not resolve or read an instance');
  const allowed = await handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-registry/status/${OWNER}`),
    envFor(`${OWNER}:2`), deps(s, spy));
  assert.deepEqual(await allowed.json(), { epoch: 7, incarnation: 2 });
  assert.equal(calls, 1);
});

test('head publish + device-CACAO head read; stranger gets 404', async () => {
  const { s, r } = await setup();
  const headName = DERIVED.headNameHex; const n = await nonce(s);
  const pub = (seq, headSha) => handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-heads/${headName}`,
    { method: 'POST', headers: { 'content-type': 'application/json', authorization: cacao(DEVICE, n, [e2eeHeadResource(headName, seq)]) },
      body: JSON.stringify({ owner: OWNER, deviceDid: DEVICE.did, seq, headSha }) }), envFor(), deps(s, r));
  assert.equal((await pub(1, '1'.repeat(64))).status, 200);
  assert.equal((await pub(1, '1'.repeat(64))).status, 200, 'idempotent retry');
  const stale = await pub(1, '2'.repeat(64));
  assert.equal(stale.status, 409);
  assert.equal((await pub(2, '2'.repeat(64))).status, 200);
  const read = await handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-heads/${headName}`,
    { headers: { authorization: cacao(DEVICE, n, [e2eeHeadReadResource(headName)]) } }), envFor(), deps(s, r));
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { seq: 2, headSha: '2'.repeat(64), headName });
  const stranger = await handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-heads/${headName}`,
    { headers: { authorization: cacao(STRANGER, n, [e2eeHeadReadResource(headName)]) } }), envFor(), deps(s, r));
  assert.equal(stranger.status, 404);
});

test('null / non-object JSON bodies answer 400 everywhere (no TypeError)', async () => {
  const { s, r } = await setup();
  const headName = DERIVED.headNameHex;
  for (const payload of ['null', '42', '[1]']) {
    const headRes = await handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-heads/${headName}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }), envFor(), deps(s, r));
    assert.equal(headRes.status, 400, `head POST with ${payload}`);
    const regRes = await handle(new Request('https://yataverse.com/awai-drive/v1/e2ee-registry/register',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }), envFor(), deps(s, r));
    assert.equal(regRes.status, 400, `register with ${payload}`);
  }
});

test('registry handler without deps.now uses the wall-clock default', async () => {
  const { s, r } = await setup();
  const { handleE2eeRegistry } = await import('../worker/src/e2ee-packs.mjs');
  const depsNoNow = deps(s, r); delete depsNoNow.now; depsNoNow.registry = r;
  depsNoNow.admitWriteRequest = () => null;
  depsNoNow.readCapped = async (req) => Buffer.from(await req.arrayBuffer());
  const res = await handleE2eeRegistry(
    new Request('https://yataverse.com/awai-drive/v1/e2ee-registry/register',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' }),
    'register', envFor(), null, depsNoNow);
  assert.equal(res.status, 400, 'no TypeError without deps.now');
});
