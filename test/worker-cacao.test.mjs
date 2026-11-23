// Writes authorized by CACAO with a fresh server-issued nonce (JUN-1426). Every negative case
// must store nothing and must fail for the reason it names; the write-token path is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { TOKEN, ENV, NOW, fakeStore, dataKeys } from './worker-fixtures.mjs';
import { handle } from '../worker/src/index.mjs';
import { NONCE_TTL_S, MAX_LIFETIME_S, blockResource, carResource, nonceProblem, verifyCacao, isCacao } from '../worker/src/cacao-auth.mjs';
import { keyFromSeed, newSeed, mintDirect } from '../src/cacao.mjs';
import { rawCid } from '../src/cid.mjs';
import { encodeCarV1 } from '../src/car.mjs';

const WRITER = keyFromSeed(newSeed());
const STRANGER = keyFromSeed(newSeed());
const CENV = { ...ENV, CACAO_NONCE_SECRET: 'test-nonce-secret-0123456789abcdef', CACAO_AUD: 'https://yataverse.com',
               CACAO_DOMAIN: 'yataverse.com', CACAO_WRITER_DIDS: `${WRITER.did}` };
const RAW = 'application/vnd.ipld.raw';
const CAR = 'application/vnd.ipld.car';
const T0 = NOW().getTime();
const at = (ms) => () => new Date(ms);

async function nonce(s, env = CENV, now = NOW) {
  const r = await handle(new Request('https://yataverse.com/auth/nonce'), env, { fetchImpl: s.fetchImpl, now });
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  return (await r.json()).nonce;
}
const cacao = (key, n, resources, extra = {}) =>
  `CACAO ${mintDirect(key, { aud: 'https://yataverse.com', domain: 'yataverse.com', nonce: n, resources, now: T0, ttlSec: 120, ...extra }).cacaoB64}`;
const put = (cid, body, authorization) =>
  new Request(`https://yataverse.com/ipfs/${cid}`, { method: 'PUT', body, headers: { authorization, 'content-type': RAW } });
const post = (body, authorization) =>
  new Request('https://yataverse.com/ipfs/', { method: 'POST', body, headers: { authorization, 'content-type': CAR } });
const code = async (res) => (await res.json()).error;
const flipAt = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
// base64url of 32 bytes has 2 spare bits in its last character: another character decodes to the same bytes.
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const respell = (s) => s.slice(0, -1) + ALPHA[ALPHA.indexOf(s.at(-1)) ^ 1];

test('a block is written with a CACAO that names its CID; the receipt records the writer', async () => {
  const s = fakeStore(); const bytes = Buffer.from('written with a cacao'); const cid = rawCid(bytes);
  const deps = { fetchImpl: s.fetchImpl, now: NOW };
  const res = await handle(put(cid, bytes, cacao(WRITER, await nonce(s), [blockResource(cid)])), CENV, deps);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.cid, cid); assert.equal(body.verified, true); assert.equal(body.receipt.v, 1);
  assert.ok(s.objects.has(`ipld/${cid}`));
  const want = '0x' + crypto.createHash('sha256').update(WRITER.did).digest('hex');
  assert.ok(JSON.stringify(body.receipt).includes(want), 'receipt names sha256(writer did)');
});

test('each refusal names its reason and stores nothing', async () => {
  const s = fakeStore(); const bytes = Buffer.from('never stored'); const cid = rawCid(bytes);
  const deps = { fetchImpl: s.fetchImpl, now: NOW };
  const n = await nonce(s);
  const res0 = [blockResource(cid)];
  const cases = [
    ['cacao-writer-not-allowed', 403, cacao(STRANGER, n, res0)],
    ['cacao-resource-does-not-match-this-write', 403, cacao(WRITER, n, [blockResource(rawCid(Buffer.from('other')))])],
    ['cacao-resource-does-not-match-this-write', 403, cacao(WRITER, n, [blockResource(cid), 'yataverse:put:extra'])],
    ['cacao-nonce-not-issued-here', 401, cacao(WRITER, 'client-chosen-nonce', res0)],
    ['cacao-nonce-not-issued-here', 401, cacao(WRITER, flipAt(n, n.length - 20), res0)],            // mac changed
    ['cacao-nonce-not-issued-here', 401, cacao(WRITER, flipAt(n, 16), res0)],                       // random part changed
    ['cacao-nonce-not-issued-here', 401, cacao(WRITER, respell(n), res0)],                          // same bytes, other spelling
    ['cacao-wrong-audience', 401, cacao(WRITER, n, res0, { aud: 'https://example.com' })],
    ['cacao-wrong-audience', 401, cacao(WRITER, n, res0, { domain: 'example.com' })],
    ['cacao-lifetime-too-long', 401, cacao(WRITER, n, res0, { ttlSec: MAX_LIFETIME_S + 1 })],
    ['cacao-issued-in-the-future', 401, cacao(WRITER, n, res0, { now: T0 + 60_000 })],
    ['cacao-malformed', 401, 'CACAO AAAAAAAAAAAAAAAAAAAAAAAA'],
    ['cacao-malformed', 401, 'CACAO not-base64!!'],
  ];
  for (const [want, status, authorization] of cases) {
    const res = await handle(put(cid, bytes, authorization), CENV, deps);
    assert.equal(res.status, status, want); assert.equal(await code(res), want);
  }
  // A signature made by another key over the same payload.
  const forged = Buffer.from(cacao(WRITER, n, res0).slice(6), 'base64');
  const sigAt = forged.length - 10; forged[sigAt] = forged[sigAt] === 0x41 ? 0x42 : 0x41;
  const bad = await handle(put(cid, bytes, `CACAO ${forged.toString('base64')}`), CENV, deps);
  assert.equal(bad.status, 401); assert.equal(await code(bad), 'cacao-bad-signature');
  assert.equal(dataKeys(s).length, 0);
});

test('a CACAO naming two resources is refused: the capability is exactly one write', async () => {
  const s = fakeStore(); const bytes = Buffer.from('two resources'); const cid = rawCid(bytes);
  const deps = { fetchImpl: s.fetchImpl, now: NOW };
  const two = cacao(WRITER, await nonce(s), [blockResource(cid), blockResource(rawCid(Buffer.from('another')))]);
  const res = await handle(put(cid, bytes, two), CENV, deps);
  assert.equal(res.status, 403); assert.equal(await code(res), 'cacao-resource-does-not-match-this-write');
  assert.equal(dataKeys(s).length, 0);
});

test('time limits: an expired CACAO and an expired nonce are refused; the boundary second still works', async () => {
  const s = fakeStore(); const bytes = Buffer.from('time'); const cid = rawCid(bytes);
  const n = await nonce(s);
  const header = cacao(WRITER, n, [blockResource(cid)], { ttlSec: 300 });
  const late = { fetchImpl: s.fetchImpl, now: at(T0 + NONCE_TTL_S * 1000) };            // nonce expiry instant
  const r1 = await handle(put(cid, bytes, header), CENV, late);
  assert.equal(r1.status, 401); assert.equal(await code(r1), 'cacao-nonce-expired');
  const short = cacao(WRITER, n, [blockResource(cid)], { ttlSec: 60 });
  const r2 = await handle(put(cid, bytes, short), CENV, { fetchImpl: s.fetchImpl, now: at(T0 + 60_000) });
  assert.equal(r2.status, 401); assert.equal(await code(r2), 'cacao-expired');
  assert.equal(dataKeys(s).length, 0);
  const justInTime = { fetchImpl: s.fetchImpl, now: at(T0 + NONCE_TTL_S * 1000 - 1) };  // one millisecond earlier
  assert.equal((await handle(put(cid, bytes, header), CENV, justInTime)).status, 201);
});

test('a nonce from another deployment secret is refused', async () => {
  const s = fakeStore(); const bytes = Buffer.from('secret'); const cid = rawCid(bytes);
  const other = await nonce(s, { ...CENV, CACAO_NONCE_SECRET: 'a-different-secret-0123456789abcdef' });
  const res = await handle(put(cid, bytes, cacao(WRITER, other, [blockResource(cid)])), CENV, { fetchImpl: s.fetchImpl, now: NOW });
  assert.equal(res.status, 401); assert.equal(await code(res), 'cacao-nonce-not-issued-here');
  assert.equal(nonceProblem(other, CENV, T0), 'cacao-nonce-not-issued-here');
  assert.equal(dataKeys(s).length, 0);
});

test('a replayed header can only repeat the same write', async () => {
  const s = fakeStore(); const bytes = Buffer.from('replay'); const cid = rawCid(bytes);
  const deps = { fetchImpl: s.fetchImpl, now: NOW };
  const header = cacao(WRITER, await nonce(s), [blockResource(cid)]);
  assert.equal((await handle(put(cid, bytes, header), CENV, deps)).status, 201);
  assert.equal((await handle(put(cid, bytes, header), CENV, deps)).status, 201);   // same content again
  const other = Buffer.from('something else'); const otherCid = rawCid(other);
  const res = await handle(put(otherCid, other, header), CENV, deps);
  assert.equal(res.status, 403); assert.equal(await code(res), 'cacao-resource-does-not-match-this-write');
  assert.deepEqual(dataKeys(s), [`ipld/${cid}`]);
});

test('a CAR is imported with a CACAO that names the SHA-256 of its body; another body is refused', async () => {
  const s = fakeStore(); const block = Buffer.from('car block'); const cid = rawCid(block);
  const car = Buffer.from(encodeCarV1([cid], [{ cid, bytes: block }]));
  const digest = crypto.createHash('sha256').update(car).digest('hex');
  const deps = { fetchImpl: s.fetchImpl, now: NOW };
  const header = cacao(WRITER, await nonce(s), [carResource(digest)]);
  const other = Buffer.from('other block'); const otherCid = rawCid(other);
  const otherCar = Buffer.from(encodeCarV1([otherCid], [{ cid: otherCid, bytes: other }]));
  const refused = await handle(post(otherCar, header), CENV, deps);
  assert.equal(refused.status, 403); assert.equal(await code(refused), 'cacao-resource-does-not-match-this-write');
  assert.equal(dataKeys(s).length, 0);
  const res = await handle(post(car, header), CENV, deps);
  assert.equal(res.status, 201);
  assert.ok(s.objects.has(`ipld/${cid}`));
  // A CACAO made for a block does not authorize a CAR.
  const blockHeader = cacao(WRITER, await nonce(s), [blockResource(cid)]);
  const wrong = await handle(post(car, blockHeader), CENV, deps);
  assert.equal(wrong.status, 403); assert.equal(await code(wrong), 'cacao-resource-does-not-match-this-write');
});

test('the scheme is off until all four settings are present, and says so instead of passing', async () => {
  const s = fakeStore(); const bytes = Buffer.from('off'); const cid = rawCid(bytes);
  const header = cacao(WRITER, await nonce(s), [blockResource(cid)]);
  for (const missing of ['CACAO_NONCE_SECRET', 'CACAO_AUD', 'CACAO_DOMAIN', 'CACAO_WRITER_DIDS']) {
    const env = { ...CENV, [missing]: '' }; const deps = { fetchImpl: s.fetchImpl, now: NOW };
    const n = await handle(new Request('https://yataverse.com/auth/nonce'), env, deps);
    assert.equal(n.status, 503, missing); assert.equal(await code(n), 'cacao-not-configured');
    const w = await handle(put(cid, bytes, header), env, deps);
    assert.equal(w.status, 503, missing); assert.equal(await code(w), 'cacao-not-configured');
    assert.deepEqual(verifyCacao(header, blockResource(cid), env, deps), { error: [503, 'cacao-not-configured'] });
  }
  assert.equal(dataKeys(s).length, 0);
  const post405 = await handle(new Request('https://yataverse.com/auth/nonce', { method: 'POST' }), CENV, { fetchImpl: s.fetchImpl, now: NOW });
  assert.equal(post405.status, 405);
});

test('write tokens still work and are not treated as CACAO', async () => {
  const s = fakeStore(); const bytes = Buffer.from('token path'); const cid = rawCid(bytes);
  assert.equal(isCacao(`Bearer ${TOKEN}`), false);
  const res = await handle(put(cid, bytes, `Bearer ${TOKEN}`), CENV, { fetchImpl: s.fetchImpl, now: NOW });
  assert.equal(res.status, 201);
});
